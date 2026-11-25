import { match } from "ts-pattern";
import type { Db } from "./db";
import { addEntry, liveEntries, type NewEntry, type ReviewEntry } from "./entries.ts";
import { emit } from "./events.ts";
import type { Check } from "./github";
import { rememberThreads } from "./terminal-replies.ts";
import { listTerminalSessions, pushToSession, type TerminalSession } from "./terminal-sessions.ts";
import { legend, threadText } from "./terminal-tools.ts";
import { isComment, reviewRoots } from "./thread-context.ts";

// ADR 0049: what the canvas sends to the agent goes, while the agent pane shows a terminal session, to that session as
// a push instead of a turn: a question or a thread's Send to agent, Submit Review's Send to Agent, a failed check. The
// session answers a thread with reply_to_thread, and later replies on it wait for it (ADR 0048 point 7).

export type TerminalSend =
  // A new question from a composer set to Agent, or a follow-up in a thread (parentId).
  | { kind: "question"; question: NewEntry }
  // A thread's Send to agent: its notes since the last question.
  | { kind: "thread"; workspaceId: number; threadId: number }
  // Submit Review's picked comment threads.
  | { kind: "review"; workspaceId: number; threadIds: number[] }
  // A failed check; prompt: what review.ts's checkPrompt says of it.
  | { kind: "check"; workspaceId: number; name: string; prompt: string };

// What the UI asks for: a check as the PR panel has it, made a prompt in the main process (review.ts loads agents.ts,
// which this file keeps out of, so tests can load it).
export type CanvasSend =
  | Exclude<TerminalSend, { kind: "check" }>
  | { kind: "check"; workspaceId: number; check: Check };

// Pushes it to the terminal session `to` (its id), which must be working on the workspace it comes from: replies with
// its tools land in its own workspace. Throws why not, before anything is saved, or when the push fails.
export async function sendToTerminal(db: Db, to: string, what: TerminalSend): Promise<void> {
  const workspaceId = what.kind === "question" ? what.question.workspaceId : what.workspaceId;
  const session = await onWorkspace(db, to, workspaceId);
  await match(what)
    .with({ kind: "question" }, ({ question }) => pushQuestion(db, session, question))
    .with({ kind: "thread" }, ({ threadId }) => pushThread(db, session, workspaceId, threadId))
    .with({ kind: "review" }, async ({ threadIds }) => {
      const text = reviewPush(await liveEntries(db, workspaceId), threadIds);
      if (!text) throw new Error("No open comment threads to send");
      await pushToSession(to, text, { kind: "review", threads: threadIds.join(",") });
    })
    .with({ kind: "check" }, ({ name, prompt }) =>
      pushToSession(to, `Check · ${name} failed\n${prompt}`, { kind: "check", check: name }),
    )
    .exhaustive();
}

async function onWorkspace(db: Db, to: string, workspaceId: number): Promise<TerminalSession> {
  const session = (await listTerminalSessions(db)).sessions.find((s) => s.session === to);
  if (!session) throw new Error("That terminal session isn't connected now");
  if (session.workspace?.id !== workspaceId)
    throw new Error(
      `${session.name ?? "That terminal session"} works on ${session.workspace?.label ?? "no workspace of coxswain's"}, so its replies wouldn't come here. Pick a session on this workspace, or tell it to use_workspace this one.`,
    );
  return session;
}

// The question is saved as one (an agent thread's entry), then pushed with its thread. Delivered, the thread is the
// session's from then on; not delivered, it becomes a note, as a question the agent never saw does (review.ts ask).
async function pushQuestion(db: Db, session: TerminalSession, question: NewEntry) {
  const root =
    question.parentId &&
    (await db
      .selectFrom("entries")
      .select("kind")
      .where("id", "=", question.parentId)
      .executeTakeFirst());
  if (root && isComment(root)) throw new Error("A comment thread doesn't go to the agent");
  const saved = await addEntry(db, "question", question);
  emit({ workspaceId: question.workspaceId, what: "entries" });
  await deliver(db, session, question.workspaceId, saved.parentId ?? saved.id, [saved.id]);
}

// The thread's notes since its last question become questions, so the thread shows them sent, and go with the thread.
async function pushThread(db: Db, session: TerminalSession, workspaceId: number, threadId: number) {
  const thread = (await liveEntries(db, workspaceId)).filter(
    (e) => e.id === threadId || e.parentId === threadId,
  );
  if (!thread.length) throw new Error(`No thread ${threadId} in this workspace`);
  const asked = thread.findLastIndex((e) => e.kind === "question");
  const notes = thread.slice(asked + 1).filter((e) => e.kind === "note");
  if (isComment(thread[0])) throw new Error("A comment thread doesn't go to the agent");
  if (!notes.length) throw new Error("Nothing new in this thread to send");
  const ids = notes.map((n) => n.id);
  await setKind(db, ids, "question");
  emit({ workspaceId, what: "entries" });
  await deliver(db, session, workspaceId, threadId, ids);
}

async function deliver(
  db: Db,
  session: TerminalSession,
  workspaceId: number,
  threadId: number,
  sent: number[],
) {
  const thread = (await liveEntries(db, workspaceId)).filter(
    (e) => e.id === threadId || e.parentId === threadId,
  );
  try {
    await pushToSession(session.session, questionPush(thread), {
      kind: "comment",
      thread: String(threadId),
    });
  } catch (error) {
    await setKind(db, sent, "note");
    emit({ workspaceId, what: "entries" });
    throw error;
  }
  // ADR 0048 point 7 keeps the session's name, as set_session_name gave it; one without a name is kept by its id.
  await rememberThreads(db, [threadId], session.name ?? session.session);
}

const setKind = (db: Db, ids: number[], kind: "note" | "question") =>
  db.updateTable("entries").set({ kind }).where("id", "in", ids).execute();

// A question as pushed: the whole thread, since a terminal session has seen none of it.
export function questionPush(thread: ReviewEntry[]): string {
  const id = thread[0].id;
  return `Comment · thread ${id}
The user asks you this in coxswain. ${legend} Answer with reply_to_thread (thread_id ${id}), where the user reads it, and make no change for it unless they ask for one.

${threadText(thread)}`;
}

// Submit Review's picked comment threads as pushed, oldest first; null when none of them is still open.
export function reviewPush(entries: ReviewEntry[], threadIds: number[]): string | null {
  const picked = new Set(threadIds);
  const roots = reviewRoots(entries).filter((e) => picked.has(e.id));
  if (!roots.length) return null;
  const parts = roots.map((root) =>
    threadText([root, ...entries.filter((e) => e.parentId === root.id)]),
  );
  return `Review · ${roots.length} thread${roots.length === 1 ? "" : "s"}
The user's review in coxswain, oldest thread first. ${legend} Work through them: make the changes they ask for, answer each thread with reply_to_thread, and resolve_thread the settled ones.

${parts.join("\n\n")}`;
}
