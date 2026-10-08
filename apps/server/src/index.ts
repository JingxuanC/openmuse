import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { readConfig } from "./config.ts";
import { createStore } from "./db.ts";
import { LocalIntelligence } from "./intelligence/local-intelligence.ts";
import { RealtimeGateway } from "./intelligence/realtime-gateway.ts";

const config = readConfig();
// Library stream races — an SSE body erroring after an AbortSignal.timeout fired elsewhere —
// surface as unhandled rejections with no application frames. Crashing the whole API over
// them kills every in-flight chat, so log and keep serving.
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});
const db = await createStore({
  dataDir: `${config.dataDir}/postgres`,
  databaseUrl: config.databaseUrl,
});
// Global by design, like the task worker: it sweeps every owner's interrupted actions at boot.
await db.recoverInterruptedActions();
const { app, agent, intelligence } = await createApp(db, config);
if (config.taskWorkerEnabled) agent.start();
const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, () =>
  console.log(`OpenMuse ${config.mode} API ready at ${config.publicUrl}`),
);
if (intelligence instanceof LocalIntelligence) new RealtimeGateway(intelligence).attach(server);
const shutdown = () => {
  server.close(() => {
    void agent
      .stop()
      .then(() => db.close())
      .then(() => process.exit(0));
  });
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
