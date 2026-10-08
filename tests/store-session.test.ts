import assert from "node:assert/strict";
import { test } from "node:test";
import { createStore, poolDatabase, Store } from "../apps/server/src/db.ts";

type Pool = Parameters<typeof poolDatabase>[0];

/**
 * A pg.Pool stand-in that records what each checked-out connection is told to run. Every checkout
 * gets its own `app.user_id` slot, the way a real connection does — which is the whole reason the
 * identity has to be pinned to a connection instead of the pool.
 */
function fakePool() {
  const log: string[] = [];
  const pool = {
    connect: async () => {
      let userId = "";
      return {
        query: async (sql: string, params?: unknown[]) => {
          log.push(sql);
          if (sql.startsWith("SELECT set_config")) userId = String(params?.[0] ?? "");
          if (sql.includes("current_setting")) return { rows: [{ data: userId }] };
          return { rows: [] };
        },
        release: () => log.push("RELEASE"),
      };
    },
    // Queries that skipped the checkout: the shared pool, which carries no identity of its own.
    query: async (sql: string) => {
      log.push(`pool: ${sql}`);
      return { rows: [{ data: "" }] };
    },
  };
  return { log, pool: pool as unknown as Pool };
}

const identity = (database: ReturnType<typeof poolDatabase>) =>
  database.query("SELECT current_setting('app.user_id', true) AS data");

test("withUser runs the callback on one connection that carries app.user_id", async () => {
  const { log, pool } = fakePool();
  const database = poolDatabase(pool);
  const seen = await new Store(database).withUser("alice", () => identity(database));
  assert.equal(seen.rows[0]?.data, "alice");
  // `set_config(..., true)` is SET LOCAL, so the setting cannot outlive the transaction on a
  // connection the pool will hand to somebody else.
  assert.deepEqual(log, [
    "BEGIN",
    "SELECT set_config('app.user_id',$1,true)",
    "SELECT current_setting('app.user_id', true) AS data",
    "COMMIT",
    "RELEASE",
  ]);
});

test("a throwing withUser callback rolls back before releasing the connection", async () => {
  const { log, pool } = fakePool();
  const store = new Store(poolDatabase(pool));
  await assert.rejects(
    store.withUser("alice", async () => {
      await store.put("alice", "drafts", { id: "draft", body: "half written" });
      throw new Error("handler failed");
    }),
    /handler failed/,
  );
  assert.equal(log[2]?.startsWith("INSERT INTO records"), true);
  assert.deepEqual(log.slice(-2), ["ROLLBACK", "RELEASE"]);
});

test("concurrent callers never share a connection or an identity", async () => {
  const { log, pool } = fakePool();
  const database = poolDatabase(pool);
  const store = new Store(database);
  const seen = await Promise.all([
    store.withUser("alice", () => identity(database)),
    store.withUser("bob", () => identity(database)),
  ]);
  assert.deepEqual(
    seen.map((result) => result.rows[0]?.data),
    ["alice", "bob"],
  );
  assert.equal(log.filter((entry) => entry === "RELEASE").length, 2);
});

test("withoutUser escapes to the shared pool for cross-owner work", async () => {
  const { pool } = fakePool();
  const database = poolDatabase(pool);
  const store = new Store(database);
  await store.withUser("alice", async () => {
    // The worker's global scan must not inherit the tenant: under RLS that would hide every other
    // owner. Its role bypasses RLS instead (infra/migrations/0001_records_rls.sql).
    const global = await store.withoutUser(() => identity(database));
    assert.equal(global.rows[0]?.data, "");
  });
});

test("withUser refuses to switch users inside one session", async () => {
  const store = await createStore();
  try {
    await assert.rejects(
      store.withUser("alice", () => store.withUser("bob", async () => {})),
      /Cannot run as bob inside alice's session/,
    );
  } finally {
    await store.close();
  }
});

test("embedded keeps local mode working: writes land under their owner", async () => {
  const store = await createStore();
  try {
    await store.withUser("local-user", () => store.put("local-user", "drafts", { id: "draft" }));
    assert.deepEqual(await store.get("local-user", "drafts", "draft"), { id: "draft" });
    assert.equal(await store.get("someone-else", "drafts", "draft"), null);
  } finally {
    await store.close();
  }
});
