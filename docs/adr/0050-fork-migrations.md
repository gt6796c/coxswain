# 50. The fork's own migrations

## Status

Accepted. Carried in the fork (gt6796c/coxswain). Extends ADR 0005's migrations; replaces the settings keys of
ADR 0023 (the Guide's scope, a requested Guide) and ADR 0048 point 7 (a thread's terminal session).

## Context

coxswain's schema is one list of migrations in `src/core/db.ts`, numbered by position and counted in SQLite's
`user_version` (ADR 0005). The fork merges upstream's releases when it wants them, and upstream keeps appending to that
list. A fork migration appended there would take a number upstream will use for a different one: after the next merge,
two databases at the same `user_version` would have different schemas, or a fork database would skip one of upstream's.
An upstream build also refuses a database whose `user_version` is past its list.

So the fork kept what needed a column in settings keys instead: `guides.scope.<workspace>`,
`guides.requested.<workspace>` and `terminal.replies.<thread>`. A setting outlives the row it describes, so the last
one carried when its thread was started, to tell its thread from a new entry SQLite gave the same id.

## Decision

1. **The fork's migrations are a second list, by name** (`forkMigrations` in `src/core/db.ts`), applied after
   upstream's, each once, in order, and recorded in `fork_migrations (name, applied_at)`. Upstream's list and
   `user_version` stay exactly upstream's, so a merge brings its new migrations in and they run first, as on upstream.
   A fork migration is appended, never edited or renamed once shipped, like upstream's.
2. **A name recorded that this build doesn't have is left alone**: a database opened by a newer fork build, then an
   older one, still opens. A fork migration must leave the schema usable by the builds before it (add tables and
   columns; don't drop or rename upstream's).
3. **Fork tables never take a name upstream has or had** (upstream's `guides` became `views`); a test checks the fork's
   `create table`s against upstream's migrations.
4. **What the settings keys held is now in tables**, moved by the migrations that make them:
   - `guide_scopes (workspace_id, scope, requested)`, one row per workspace with a Guide whose scope or request was
     recorded; none means a Guide of all of the changes, written by coxswain (ADR 0023).
   - `terminal_threads (thread_id, session)`: the terminal session a thread's replies wait for (ADR 0048 point 7). Only
     a setting whose `startedAt` was still its thread's is moved.

   Both cascade from their workspace or thread, so nothing outlives what it describes, and a reused entry id starts
   with no session.

## Alternatives considered

- **Fork migrations in upstream's list, renumbered at each merge**: every merge rewrites migrations that have already
  run on the user's database. Exactly what ADR 0005 forbids.
- **Starting the fork's migrations at a high `user_version` (1000+)**: an upstream build would refuse the database, and
  the next upstream migration would be skipped on a database already past it.
- **Keep the settings keys**: no schema change, but each carries a JSON value parsed by hand, outlives its row, and
  needs the `startedAt` check against reused ids.

## Consequences

- Merging upstream needs no thought about migration numbers; a fork migration that depends on an upstream table runs
  after that table's own migrations.
- A database the fork has migrated still opens in an upstream build (its `user_version` is upstream's), which ignores
  the fork's tables and loses only what they hold: Guide scopes, requested Guides, threads waiting for a terminal
  session.
- If upstream ever adds a migration that conflicts with a fork table (same name, or a column the fork relied on), the
  fork's migration must be adapted by hand at that merge; the name test catches only the first.
- `fork_migrations` is created by `openDatabase` itself, before the fork's migrations, not by one of them.
