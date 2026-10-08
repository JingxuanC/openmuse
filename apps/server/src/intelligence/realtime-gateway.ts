import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { type WebSocket, WebSocketServer } from "ws";
import { type LocalIntelligence, LocalIntelligenceError } from "./local-intelligence.ts";

/**
 * Minimal Phoenix-Channels (v2 JSON serializer) endpoint that replaces the
 * CopilotKit Intelligence realtime gateway. The runtime's
 * `IntelligenceAgentRunner` pushes AG-UI events to `ingestion:{runId}` topics;
 * this gateway persists them through `LocalIntelligence` and rebroadcasts them
 * to `thread:{threadId}` subscribers (the RN client, and server-side replay
 * sockets), which is the only channel through which intelligence-mode clients
 * receive run events. Replay cursors and the `replay_complete` / `stream_idle`
 * control events mirror the platform contract the `@copilotkit/core` client
 * implements.
 */

type PhoenixMessage = [string | null, string | null, string, string, unknown];

interface Member {
  socket: WebSocket;
  plane: "runner" | "client";
}

interface Connection {
  socket: WebSocket;
  plane: "runner" | "client";
  joinToken: string | null;
  topics: Map<string, string | null>; // topic -> joinRef
  queue: Promise<void>;
}

const AG_UI_EVENT = "ag_ui_event";
const TERMINAL_EVENTS = new Set(["RUN_FINISHED", "RUN_ERROR"]);

function send(socket: WebSocket, message: PhoenixMessage) {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
}

function reply(
  socket: WebSocket,
  joinRef: string | null,
  ref: string | null,
  topic: string,
  response: Record<string, unknown>,
  status: "ok" | "error" = "ok",
) {
  if (ref === null) return;
  send(socket, [joinRef, ref, topic, "phx_reply", { status, response }]);
}

const AUTH_TOKEN_PREFIX = "base64url.bearer.phx.";

/** The runtime's runner authenticates its Phoenix socket with a bearer subprotocol. */
function subprotocolToken(request: IncomingMessage): string | null {
  const header = request.headers["sec-websocket-protocol"];
  if (!header) return null;
  for (const protocol of header.split(",")) {
    const trimmed = protocol.trim();
    if (trimmed.startsWith(AUTH_TOKEN_PREFIX))
      return Buffer.from(trimmed.slice(AUTH_TOKEN_PREFIX.length), "base64url").toString("utf8");
  }
  return null;
}

export class RealtimeGateway {
  private readonly wss = new WebSocketServer({
    noServer: true,
    // Phoenix offers ["phoenix", "phx-token-…"]; the handshake fails unless one is selected.
    handleProtocols: (protocols) => (protocols.has("phoenix") ? "phoenix" : false),
  });
  private readonly topics = new Map<string, Set<Member>>();
  private readonly connections = new Set<Connection>();
  private readonly activeRuns = new Map<string, Set<string>>(); // threadId -> runIds
  private closed = false;

  constructor(private readonly intelligence: LocalIntelligence) {}

  /** The gateway paths track the intelligence WS base, which tests can re-point after construction. */
  private paths() {
    return {
      runner: `${new URL(this.intelligence.ɵgetRunnerWsUrl()).pathname}/websocket`,
      client: `${new URL(this.intelligence.ɵgetClientWsUrl()).pathname}/websocket`,
    };
  }

  /** Attach to the HTTP server's upgrade event; the gateway owns every upgrade request. */
  attach(server: {
    on(
      event: "upgrade",
      listener: (request: IncomingMessage, socket: Duplex, head: Buffer) => void,
    ): unknown;
  }) {
    server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      const paths = this.paths();
      const plane = this.closed
        ? null
        : url.pathname === paths.runner
          ? ("runner" as const)
          : url.pathname === paths.client
            ? ("client" as const)
            : null;
      // Node leaves the socket open when an `upgrade` listener ignores it, so a
      // refused handshake never reaches the client as open, error, or close —
      // anything awaiting that socket waits forever. Refuse it instead.
      if (!plane) {
        socket.destroy();
        return;
      }
      if (plane === "runner" && subprotocolToken(request) !== this.intelligence.runnerAuthToken()) {
        socket.destroy();
        return;
      }
      const joinToken = url.searchParams.get("join_token");
      this.wss.handleUpgrade(request, socket, head, (webSocket) => {
        this.accept(webSocket, plane, joinToken);
      });
    });
  }

  close() {
    this.closed = true;
    for (const connection of this.connections) {
      // 1000 tells a Phoenix client the shutdown is intentional; an unclean
      // close makes it and the runner reconnect against a closing gateway.
      connection.socket.close(1000, "gateway closing");
    }
    this.connections.clear();
    this.topics.clear();
    this.activeRuns.clear();
    this.wss.close();
  }

  private accept(socket: WebSocket, plane: "runner" | "client", joinToken: string | null) {
    const connection: Connection = {
      socket,
      plane,
      joinToken,
      topics: new Map(),
      queue: Promise.resolve(),
    };
    this.connections.add(connection);
    socket.on("message", (data) => {
      // Serialize per-connection handling so events persist in arrival order;
      // the runner waits for each ack before completing a run.
      connection.queue = connection.queue
        .then(() => this.handle(connection, data.toString()))
        .catch((error) => console.error(`[OpenMuse] realtime gateway: ${error}`));
    });
    socket.on("close", () => this.drop(connection));
  }

  private drop(connection: Connection) {
    for (const topic of connection.topics.keys()) this.removeMember(topic, connection);
    this.connections.delete(connection);
  }

  private removeMember(topic: string, connection: Connection) {
    const members = this.topics.get(topic);
    if (!members) return;
    for (const member of members) if (member.socket === connection.socket) members.delete(member);
    if (members.size === 0) this.topics.delete(topic);
    connection.topics.delete(topic);
    if (topic.startsWith("ingestion:")) this.markRunIdle(topic);
  }

  private markRunIdle(topic: string) {
    for (const [threadId, runIds] of this.activeRuns) {
      if (runIds.delete(topic.slice("ingestion:".length)) && runIds.size === 0)
        this.activeRuns.delete(threadId);
    }
  }

  private broadcast(topic: string, event: string, payload: unknown, except?: WebSocket) {
    for (const member of this.topics.get(topic) ?? []) {
      if (member.socket === except) continue;
      send(member.socket, [null, null, topic, event, payload]);
    }
  }

  private async handle(connection: Connection, raw: string) {
    let message: PhoenixMessage;
    try {
      message = JSON.parse(raw) as PhoenixMessage;
    } catch {
      return;
    }
    if (!Array.isArray(message) || message.length < 5) return;
    const [joinRef, ref, topic, event, payload] = message;
    if (event === "heartbeat") {
      reply(connection.socket, null, ref, topic, {});
      return;
    }
    if (event === "phx_join") {
      await this.join(connection, joinRef, ref, topic, payload as Record<string, unknown>);
      return;
    }
    if (event === "phx_leave") {
      reply(connection.socket, joinRef, ref, topic, {});
      this.removeMember(topic, connection);
      return;
    }
    if (!connection.topics.has(topic) && !topic.startsWith("ingestion:")) return;
    if ((event === "event" || event === "events") && topic.startsWith("ingestion:")) {
      const events =
        event === "events" ? ((payload as { events?: unknown[] }).events ?? []) : [payload];
      try {
        await this.ingestBatch(topic, events as Record<string, unknown>[]);
      } catch (error) {
        // The runner treats this reply as the run's durability barrier and waits out
        // EVENT_DURABILITY_DEADLINE_MS before failing the thread, so staying silent reports an
        // opaque timeout a minute after the answer already streamed. A client error is
        // permanent — retrying cannot conjure the thread — and saying so fails the run now,
        // with the reason; anything else may be transient, so let the runner retry it.
        const permanent =
          error instanceof LocalIntelligenceError && error.status >= 400 && error.status < 500;
        const reason = error instanceof Error ? error.message : String(error);
        console.error(`[OpenMuse] realtime gateway: rejected ${topic}: ${reason}`);
        reply(connection.socket, joinRef, ref, topic, { reason, retryable: !permanent }, "error");
        return;
      }
      reply(connection.socket, joinRef, ref, topic, {});
      return;
    }
    if (event === AG_UI_EVENT) {
      // Client-pushed channel events (for example a stop signal) reach the other
      // topic members, mirroring platform fan-out.
      this.broadcast(topic, event, payload, connection.socket);
      reply(connection.socket, joinRef, ref, topic, {});
      return;
    }
    reply(connection.socket, joinRef, ref, topic, {});
  }

  private async join(
    connection: Connection,
    joinRef: string | null,
    ref: string | null,
    topic: string,
    params: Record<string, unknown>,
  ) {
    if (connection.plane === "client" && topic.startsWith("thread:")) {
      // The client presents its run/connect join token as a socket-level query param.
      if (
        !this.intelligence.validateJoinToken(topic.slice("thread:".length), connection.joinToken)
      ) {
        reply(connection.socket, joinRef, ref, topic, { reason: "unauthorized" }, "error");
        // Answer first, then hang up: an unauthenticated socket must not stay
        // open, and messages on a topic that was never joined are dropped
        // without a reply, so a client waiting on it would wait forever.
        connection.socket.close(1008, "unauthorized");
        return;
      }
    }
    const members = this.topics.get(topic) ?? new Set<Member>();
    members.add({ socket: connection.socket, plane: connection.plane });
    this.topics.set(topic, members);
    connection.topics.set(topic, joinRef);
    if (topic.startsWith("ingestion:")) {
      const threadId = typeof params?.thread_id === "string" ? params.thread_id : undefined;
      if (threadId) {
        const runs = this.activeRuns.get(threadId) ?? new Set<string>();
        runs.add(topic.slice("ingestion:".length));
        this.activeRuns.set(threadId, runs);
      }
      // Batching keeps long streaming runs inside the runner's durability
      // deadline: without it the runner pushes one event per round trip.
      reply(connection.socket, joinRef, ref, topic, {
        capabilities: ["runner_event_batch_v1"],
      });
      return;
    }
    reply(connection.socket, joinRef, ref, topic, {});
    if (topic.startsWith("thread:")) await this.replay(connection, topic, params);
  }

  /** Replay persisted events to a fresh `thread:` subscriber, then signal replay/idle state. */
  private async replay(connection: Connection, topic: string, params: Record<string, unknown>) {
    const threadId = topic.slice("thread:".length);
    const events = await this.intelligence.threadEvents(threadId);
    const streamMode = typeof params?.stream_mode === "string" ? params.stream_mode : "connect";
    const runId = typeof params?.run_id === "string" ? params.run_id : undefined;
    const cursor =
      typeof params?.last_seen_event_id === "string" ? params.last_seen_event_id : null;
    let pastCursor = cursor === null;
    let latestEventId: string | undefined;
    for (const event of events) {
      const metadata = event.metadata as { cpki_event_id?: unknown } | undefined;
      const eventId =
        typeof metadata?.cpki_event_id === "string" ? metadata.cpki_event_id : undefined;
      if (streamMode === "run" && runId) {
        if (event.run_id !== runId && event.runId !== runId) continue;
      } else if (!pastCursor) {
        if (eventId === cursor) pastCursor = true;
        continue;
      }
      // A historical RUN_ERROR belongs to a run that is long over; replaying it makes the
      // client's connect fail ("Could not load conversation") and bricks the thread even
      // though the backend is healthy. Only live run attachments see terminal errors.
      if (streamMode !== "run" && (event.type === "RUN_ERROR" || event.event_type === "RUN_ERROR"))
        continue;
      send(connection.socket, [null, null, topic, AG_UI_EVENT, event]);
      if (eventId) latestEventId = eventId;
    }
    if (streamMode === "run") return;
    send(connection.socket, [null, null, topic, "replay_complete", { latestEventId }]);
    if (!this.activeRuns.has(threadId))
      send(connection.socket, [null, null, topic, "stream_idle", { latestEventId }]);
  }

  /**
   * Persist a batch of runner events with one store round trip per thread, then
   * fan each event out in order so subscribers see the same stream as before.
   */
  private async ingestBatch(topic: string, events: Record<string, unknown>[]) {
    const runId = topic.slice("ingestion:".length);
    const byThread = new Map<string, Record<string, unknown>[]>();
    for (const event of events) {
      const threadId =
        (typeof event.threadId === "string" && event.threadId) ||
        (typeof event.thread_id === "string" && event.thread_id) ||
        undefined;
      if (!threadId) continue;
      const list = byThread.get(threadId) ?? [];
      list.push(event);
      byThread.set(threadId, list);
    }
    for (const [threadId, threadEvents] of byThread) {
      const { latestEventId } = await this.intelligence.appendThreadEvents(
        threadId,
        threadEvents,
        runId,
      );
      for (const event of threadEvents) {
        this.broadcast(`thread:${threadId}`, AG_UI_EVENT, event);
        if (typeof event.type === "string" && TERMINAL_EVENTS.has(event.type)) {
          this.markRunIdle(topic);
          this.broadcast(`thread:${threadId}`, "stream_idle", { latestEventId });
        }
      }
    }
  }
}
