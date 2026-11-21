import type { Db } from "./db";

// ADR 0048: the user's replies on what a terminal session wrote reach that session. The session names itself
// (set_session_name, as ListAgents shows it); each finding or explanation it adds afterwards remembers that name in
// settings (a column would be a migration). A reply sent to the agent on such a thread carries forwardText, so
// coxswain's agent passes it on with SendMessage, the one way into another Claude session.
// ponytail: only Claude Code agent panes have SendMessage; with another agent, or the session gone, the agent answers
// itself. A push straight into the session (Claude Code channels) would drop the agent pane from the path.

const key = (threadId: number) => `terminal.replies.${threadId}`;

// The threads a session started since `after` (an entry id), remembered as its.
export async function rememberThreads(
  db: Db,
  workspaceId: number,
  after: number,
  session: string,
): Promise<number> {
  const roots = await db
    .selectFrom("entries")
    .select("id")
    .where("workspace_id", "=", workspaceId)
    .where("id", ">", after)
    .where("parent_id", "is", null)
    .where("kind", "in", ["finding", "explanation"])
    .execute();
  for (const { id } of roots)
    await db
      .insertInto("settings")
      .values({ key: key(id), value: session })
      .onConflict((oc) => oc.column("key").doUpdateSet({ value: session }))
      .execute();
  return roots.length;
}

// The newest entry's id, to tell the entries a call adds.
export async function lastEntryId(db: Db): Promise<number> {
  const row = await db
    .selectFrom("entries")
    .select((eb) => eb.fn.max("id").as("id"))
    .executeTakeFirst();
  return Number(row?.id ?? 0);
}

// What a reply on the thread adds to the agent's prompt: forwarding it, when a terminal session wrote the thread.
export async function forwardNote(db: Db, threadId: number): Promise<string> {
  const row = await db
    .selectFrom("settings")
    .select("value")
    .where("key", "=", key(threadId))
    .executeTakeFirst();
  return row ? forwardText(row.value, threadId) : "";
}

export const forwardText = (session: string, threadId: number) =>
  `This thread began with what the Claude session \`${session}\` wrote from a terminal: it owns this review and answers in the thread itself. Pass my comment on with SendMessage to "${session}": thread ${threadId}, where it points, and my words as written. Then answer only "Forwarded to ${session}." If SendMessage can't reach it, answer my comment yourself, starting "${session} isn't reachable, so I'm answering."`;
