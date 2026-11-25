import type { Db } from "./db";
import { addEntry, type NewEntry } from "./entries.ts";
import { emit } from "./events.ts";

// ADR 0048: the user's replies on what a terminal session wrote wait for that session. The session names itself
// (set_session_name, as ListAgents shows it); each finding or explanation it adds afterwards remembers that name in
// the fork's terminal_threads table (ADR 0050). A reply on such a thread stays a note instead of going to the agent
// pane, so it waits in read_review until the user tells the session to take the comments, all at once.
// With the session picked in the agent pane, a reply sent to the agent is pushed to it (ADR 0049, terminal-sends.ts).
// ponytail: otherwise nothing tells the session comments are waiting; the user does.

// The findings and explanations started in the workspace since `after` (an entry id): what a call just added.
export async function threadsAfter(db: Db, workspaceId: number, after: number): Promise<number[]> {
  const roots = await db
    .selectFrom("entries")
    .select("id")
    .where("workspace_id", "=", workspaceId)
    .where("id", ">", after)
    .where("parent_id", "is", null)
    .where("kind", "in", ["finding", "explanation"])
    .execute();
  return roots.map((r) => r.id);
}

// Threads remembered as a session's, so replies on them wait for it. A row goes with its thread (deleted with its view
// when the Guide is replaced), so an id SQLite gives to a new entry again isn't the session's. Ids of threads already
// gone are skipped.
export async function rememberThreads(db: Db, threadIds: number[], session: string) {
  if (!threadIds.length) return;
  const threads = await db
    .selectFrom("entries")
    .select("id")
    .where("id", "in", threadIds)
    .execute();
  for (const { id } of threads)
    await db
      .insertInto("terminal_threads")
      .values({ thread_id: id, session })
      .onConflict((oc) => oc.column("thread_id").doUpdateSet({ session }))
      .execute();
}

// The newest entry's id, to tell the entries a call adds.
export async function lastEntryId(db: Db): Promise<number> {
  const row = await db
    .selectFrom("entries")
    .select((eb) => eb.fn.max("id").as("id"))
    .executeTakeFirst();
  return Number(row?.id ?? 0);
}

// A reply on a terminal session's thread, kept as a note for it: nothing goes to the agent pane, so null.
export async function waitForTerminal(db: Db, e: NewEntry): Promise<null> {
  await addEntry(db, "note", e);
  emit({ workspaceId: e.workspaceId, what: "entries" });
  return null;
}

// The terminal session a thread's replies wait for, or null when they go to the agent pane as usual.
export async function terminalSession(db: Db, threadId: number): Promise<string | null> {
  const row = await db
    .selectFrom("terminal_threads")
    .select("session")
    .where("thread_id", "=", threadId)
    .executeTakeFirst();
  return row?.session ?? null;
}
