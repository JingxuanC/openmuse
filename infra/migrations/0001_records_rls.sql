-- Tenant isolation for OpenMuse's Postgres. There is no migration runner yet, so this file is not
-- applied automatically: a deployment that wants RLS applies it by hand against the database in
-- DATABASE_URL, as a superuser or the table owner. Phase 1 prepares the file only.
--
-- The request path opens a transaction and sets `app.user_id` from the verified JWT subject before
-- running a handler (Store.withUser, apps/server/src/db.ts); the policies below read that setting.
-- Every policy fails closed: with no setting in scope `current_setting(..., true)` is NULL (or the
-- empty string after a transaction ends), which matches no owner.

ALTER TABLE records ENABLE ROW LEVEL SECURITY;

-- The connecting role owns `records` (it runs the CREATE TABLE IF NOT EXISTS at boot), and a table
-- owner bypasses RLS unless FORCE is set. Contrast with BYPASSRLS below, which still overrides FORCE.
ALTER TABLE records FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS records_owner ON records;
CREATE POLICY records_owner ON records
  USING (current_setting('app.user_id', true) = owner)
  WITH CHECK (current_setting('app.user_id', true) = owner);

-- The task worker scans every owner (apps/server/src/engine/worker.ts) and the boot-time recovery
-- sweep rewrites every owner's interrupted actions (apps/server/src/index.ts). Both must connect as
-- a role that bypasses RLS, or they would silently see one tenant and stall every other one. Run
-- this once as a superuser, with a real password, and point the worker's DATABASE_URL at the role:
--
--   CREATE ROLE openmuse_worker LOGIN BYPASSRLS PASSWORD '<generate one>';
--   GRANT SELECT, INSERT, UPDATE, DELETE ON records TO openmuse_worker;
--
-- `records` currently lives in the connection's default schema; if the table moves to the planned
-- `openmuse.*` schema (DESIGN.md §3.2), qualify the three statements above.

-- Known gaps before RLS can be turned on for real, none of which this file resolves:
--   * Records owned by `system` (sessions, worker-status) and the thread->owner index in
--     local-intelligence.ts are written and read outside any user transaction.
--   * /api/session and /api/google/callback are registered ahead of the /api/* middleware in
--     apps/server/src/app.ts, so their writes run without a user transaction.
--   * CopilotKit's runtime persists thread messages while a response body is still streaming,
--     which is after the request's transaction has committed.
