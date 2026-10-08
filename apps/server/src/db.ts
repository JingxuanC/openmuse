import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import { backgroundFailure } from "./log.ts";

type Row = { data: Record<string, unknown> };
/** What a pooled pg client and the embedded PGlite instance have in common, so a query can be routed to either. */
interface Queryable {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Row[] }>;
}
interface Database extends Queryable {
  withUser: <T>(userId: string, fn: () => Promise<T>) => Promise<T>;
  withoutUser: <T>(fn: () => Promise<T>) => Promise<T>;
  close: () => Promise<void>;
}

interface UserSession extends Queryable {
  userId: string;
}

/**
 * The connection a request's queries must run on. A pool hands a different connection to each query,
 * so `SET LOCAL app.user_id` only constrains the queries issued on the connection that ran it: the
 * identity has to travel with the async call, not with the pool.
 */
const session = new AsyncLocalStorage<UserSession>();

/**
 * One identity per request. Re-entering for the same user reuses the session; switching users
 * mid-request is a bug, and on Postgres it would also hold a second connection for no reason.
 * Embedded PGlite is a single connection, where a second transaction would deadlock outright.
 */
function reenter<T>(open: UserSession, userId: string, fn: () => Promise<T>): Promise<T> {
  if (open.userId === userId) return fn();
  throw new Error(`Cannot run as ${userId} inside ${open.userId}'s session`);
}

export class Store {
  constructor(private readonly db: Database) {}
  /**
   * Runs `fn` with every Store query in the caller's identity. On Postgres that is one checked-out
   * connection inside a transaction carrying `app.user_id` — what an RLS policy reads
   * (`infra/migrations/0001_records_rls.sql`) — and `SET LOCAL` expires with it, so the pooled
   * connection keeps no user id. Embedded PGlite has a single connection and no RLS, so it carries
   * the identity without a transaction; see pgliteDatabase.
   */
  withUser<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    return this.db.withUser(userId, fn);
  }
  /** The escape hatch for cross-owner work: see TaskWorker.tick. */
  withoutUser<T>(fn: () => Promise<T>): Promise<T> {
    return this.db.withoutUser(fn);
  }
  async get<T = Record<string, unknown>>(
    owner: string,
    kind: string,
    id: string,
  ): Promise<T | null> {
    const result = await this.db.query(
      "SELECT data FROM records WHERE owner=$1 AND kind=$2 AND id=$3",
      [owner, kind, id],
    );
    return (result.rows[0]?.data as T | undefined) ?? null;
  }
  async list<T = Record<string, unknown>>(owner: string, kind: string): Promise<T[]> {
    const result = await this.db.query(
      "SELECT data FROM records WHERE owner=$1 AND kind=$2 ORDER BY updated_at DESC,id",
      [owner, kind],
    );
    return result.rows.map((row) => row.data as T);
  }
  async put<T extends { id: string }>(owner: string, kind: string, value: T): Promise<T> {
    await this.db.query(
      "INSERT INTO records(owner,kind,id,data) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(owner,kind,id) DO UPDATE SET data=excluded.data,updated_at=now()",
      [owner, kind, value.id, JSON.stringify(value)],
    );
    return value;
  }
  async remove(owner: string, kind: string, id: string): Promise<void> {
    await this.db.query("DELETE FROM records WHERE owner=$1 AND kind=$2 AND id=$3", [
      owner,
      kind,
      id,
    ]);
  }
  async compareAndSwap<T>(
    owner: string,
    kind: string,
    id: string,
    expected: Record<string, unknown>,
    patch: Record<string, unknown>,
  ): Promise<T | null> {
    const result = await this.db.query(
      "UPDATE records SET data=data || $5::jsonb,updated_at=now() WHERE owner=$1 AND kind=$2 AND id=$3 AND data @> $4::jsonb RETURNING data",
      [owner, kind, id, JSON.stringify(expected), JSON.stringify(patch)],
    );
    return (result.rows[0]?.data as T | undefined) ?? null;
  }
  async insertIfAbsent<T extends { id: string }>(
    owner: string,
    kind: string,
    value: T,
  ): Promise<T | null> {
    const result = await this.db.query(
      "INSERT INTO records(owner,kind,id,data) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING RETURNING data",
      [owner, kind, value.id, JSON.stringify(value)],
    );
    return (result.rows[0]?.data as T | undefined) ?? null;
  }
  async scan<T>(kind: string): Promise<{ owner: string; value: T }[]> {
    const result = await this.db.query(
      "SELECT jsonb_build_object('owner',owner,'value',data) AS data FROM records WHERE kind=$1 ORDER BY updated_at ASC",
      [kind],
    );
    return result.rows.map((row) => row.data as { owner: string; value: T });
  }
  async claim<T>(owner: string, id: string, status: string, now: string): Promise<T | null> {
    const result = await this.db.query(
      `UPDATE records AS action SET data=jsonb_set(data,'{status}',$4::jsonb),updated_at=now()
       WHERE owner=$1 AND kind='actions' AND id=$2 AND data->>'status'='awaiting_review'
       AND (data->>'expiresAt')::timestamptz>$3::timestamptz
       AND ($4::jsonb <> '"executing"'::jsonb OR data->>'taskId' IS NULL OR EXISTS (
         SELECT 1 FROM records task WHERE task.owner=action.owner AND task.kind='tasks'
         AND task.id=action.data->>'taskId' AND task.data->>'status' IN ('running','waiting_approval')
       )) RETURNING data`,
      [owner, id, now, JSON.stringify(status)],
    );
    return (result.rows[0]?.data as T | undefined) ?? null;
  }
  /**
   * Deliberately cross-owner: this runs at boot (apps/server/src/index.ts) before any request has an
   * identity, and a crash mid-execution is nobody's request. Each repaired row keeps the owner it
   * was written under, so the sweep restores ownership rather than reassigning it.
   */
  async recoverInterruptedActions(): Promise<void> {
    await this.db.query(
      `UPDATE records SET data=data || '{"status":"outcome_unknown","error":"Server restarted during execution. Check the provider before creating another action."}'::jsonb WHERE kind='actions' AND data->>'status'='executing'`,
    );
  }
  async take<T>(owner: string, kind: string, id: string): Promise<T | null> {
    const result = await this.db.query(
      "DELETE FROM records WHERE owner=$1 AND kind=$2 AND id=$3 RETURNING data",
      [owner, kind, id],
    );
    return (result.rows[0]?.data as T | undefined) ?? null;
  }
  close(): Promise<void> {
    return this.db.close();
  }
  async updateCredential(owner: string, connectionId: string, secret: string): Promise<boolean> {
    const result = await this.db.query(
      "UPDATE records SET data=jsonb_set(data,'{secret}',$3::jsonb),updated_at=now() WHERE owner=$1 AND kind='credentials' AND id='google' AND data->>'connectionId'=$2 RETURNING data",
      [owner, connectionId, JSON.stringify(secret)],
    );
    return result.rows.length === 1;
  }
}

/** Idle clients can be disconnected by a database restart; without a listener pg's `error` event crashes the process. */
export function createPool(connectionString: string) {
  const pool = new pg.Pool({ connectionString, max: 5 });
  pool.on("error", (error) => backgroundFailure("postgres pool", error));
  return pool;
}

/** Split out so tests can point the Postgres path at a recorded stand-in connection. */
export function poolDatabase(pool: pg.Pool): Database {
  return {
    query: (sql, params) => (session.getStore() ?? pool).query(sql, params),
    async withUser(userId, fn) {
      const open = session.getStore();
      if (open) return reenter(open, userId, fn);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        // `set_config(..., true)` is SET LOCAL: the setting dies with the transaction instead of
        // outliving the request on a connection the pool will hand to somebody else.
        await client.query("SELECT set_config('app.user_id',$1,true)", [userId]);
        const result = await session.run(
          { userId, query: (sql, params) => client.query(sql, params) },
          fn,
        );
        await client.query("COMMIT");
        return result;
      } catch (error) {
        // A commit that never landed leaves the transaction open; clear it before releasing.
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
    withoutUser: (fn) => session.exit(fn),
    close: () => pool.end(),
  };
}

function pgliteDatabase(embedded: PGlite): Database {
  return {
    query: (sql, params) => (session.getStore() ?? embedded).query<Row>(sql, params),
    async withUser(userId, fn) {
      const open = session.getStore();
      if (open) return reenter(open, userId, fn);
      // Embedded PGlite has one connection, shared with the task worker that runs in-process by
      // default, and no RLS to satisfy: a request holding a transaction for its whole duration would
      // stall that worker and deadlock outright where a handler awaits a tick. The identity still
      // travels with the call, so callers see one contract on both backends.
      return session.run({ userId, query: (sql, params) => embedded.query<Row>(sql, params) }, fn);
    },
    withoutUser: (fn) => session.exit(fn),
    close: () => embedded.close(),
  };
}

/** The connection wiring createStore is built on, exposed so tests can run raw SQL in the same session. */
export async function createDatabase(
  options: { dataDir?: string; databaseUrl?: string } = {},
): Promise<Database> {
  if (options.databaseUrl) return poolDatabase(createPool(options.databaseUrl));
  if (options.dataDir) await mkdir(dirname(options.dataDir), { recursive: true, mode: 0o700 });
  const embedded = new PGlite(options.dataDir);
  await embedded.waitReady;
  return pgliteDatabase(embedded);
}

export async function createStore(
  options: { dataDir?: string; databaseUrl?: string } = {},
): Promise<Store> {
  const database = await createDatabase(options);
  // Schema setup runs as the owner, outside any user transaction.
  await database.query(
    "CREATE TABLE IF NOT EXISTS records(owner text NOT NULL,kind text NOT NULL,id text NOT NULL,data jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(owner,kind,id))",
  );
  return new Store(database);
}
