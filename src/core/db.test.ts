import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { forkMigrations, migrations, openDatabase } from "./db.ts";

// ADR 0050: the fork's migrations run after upstream's, once each, without touching user_version.
const temp = mkdtempSync(join(os.tmpdir(), "cx-db-"));
after(() => rmSync(temp, { recursive: true, force: true }));
// node:sqlite's rows have no prototype; deepEqual compares them with plain objects.
const plain = (rows: object[]) => rows.map((r) => ({ ...r }));

// A database as an upstream build leaves it: every upstream migration, none of the fork's.
function upstreamDatabase(path: string, setup: string) {
  const db = new DatabaseSync(path);
  db.exec("pragma foreign_keys = off");
  for (const m of migrations) db.exec(m);
  db.exec(`pragma user_version = ${migrations.length}`);
  db.exec(setup);
  db.close();
}

test("the fork's migrations move the Guide's and terminal threads' settings into tables", async (t) => {
  const path = join(temp, "upstream.db");
  upstreamDatabase(
    path,
    `insert into projects (id, name, path, last_opened_at) values (1, 'app', '/app', '');
    insert into workspaces (id, project_id, branch, base_branch, last_opened_at) values (1, 1, 'feature', 'main', '');
    insert into entries (id, workspace_id, kind, body, created_at) values
      (10, 1, 'finding', 'kept', '2026-11-20T00:00:00Z'),
      (11, 1, 'finding', 'took a deleted thread''s id', '2026-11-21T00:00:00Z');
    insert into settings (key, value) values
      ('guides.scope.1', 'uncommitted'),
      ('guides.requested.1', '1'),
      ('guides.scope.99', 'pinned'),
      ('terminal.replies.10', '{"session":"backend-b0","startedAt":"2026-11-20T00:00:00Z"}'),
      ('terminal.replies.11', '{"session":"backend-b0","startedAt":"2026-11-01T00:00:00Z"}'),
      ('terminal.replies.12', 'backend-b0'),
      ('comment.to-agent', 'true')`,
  );

  const db = openDatabase(path);
  t.after(() => db.destroy());
  assert.deepEqual(plain(await db.selectFrom("guide_scopes").selectAll().execute()), [
    { workspace_id: 1, scope: "uncommitted", requested: 1 },
  ]);
  assert.deepEqual(plain(await db.selectFrom("terminal_threads").selectAll().execute()), [
    { thread_id: 10, session: "backend-b0" },
  ]);
  assert.deepEqual(plain(await db.selectFrom("settings").selectAll().execute()), [
    { key: "comment.to-agent", value: "true" },
  ]);
  assert.deepEqual(
    (await db.selectFrom("fork_migrations").select("name").execute()).map((r) => r.name),
    forkMigrations.map((m) => m.name),
  );

  // Rows go with their workspace and thread.
  await db.deleteFrom("entries").where("id", "=", 10).execute();
  assert.equal((await db.selectFrom("terminal_threads").selectAll().execute()).length, 0);
  await db.deleteFrom("workspaces").where("id", "=", 1).execute();
  assert.equal((await db.selectFrom("guide_scopes").selectAll().execute()).length, 0);
});

test("upstream's numbering is untouched, and opening again runs nothing twice", async (t) => {
  const path = join(temp, "again.db");
  openDatabase(path).destroy();
  const raw = new DatabaseSync(path);
  const version = raw.prepare("pragma user_version").get() as { user_version: number };
  // One the fork has dropped, or a newer fork build added, stays recorded and isn't a problem.
  raw.exec("insert into fork_migrations (name, applied_at) values ('from-a-newer-build', '')");
  raw.close();
  assert.equal(version.user_version, migrations.length);

  const db = openDatabase(path);
  t.after(() => db.destroy());
  const names = (await db.selectFrom("fork_migrations").select("name").execute()).map(
    (r) => r.name,
  );
  assert.deepEqual(
    names.toSorted(),
    [...forkMigrations.map((m) => m.name), "from-a-newer-build"].toSorted(),
  );
});

test("fork migration names are unique, and fork tables aren't upstream's", () => {
  const names = forkMigrations.map((m) => m.name);
  assert.equal(new Set(names).size, names.length);
  const upstream = migrations.join("\n");
  for (const m of forkMigrations)
    for (const [, table] of m.sql.matchAll(/create table (\w+)/g))
      assert.doesNotMatch(upstream, new RegExp(`\\btable ${table}\\b`), `${table} is upstream's`);
});
