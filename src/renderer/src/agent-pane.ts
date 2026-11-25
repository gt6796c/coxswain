import { useSyncExternalStore } from "react";
import type { Agent, ChatEntry } from "../../core/agents";
import type { Attachment } from "../../core/attachments";
import type { AttachedPrompt } from "../../core/views";

// Presentation state lives for the window, not for one mounting of Agents. In particular a session
// may finish starting after its workspace has been hidden. Live turns themselves belong to the core.
type Pane = {
  // The last prompt the New View menu attached, so the same one isn't attached twice; attached: the one on the
  // composer, sent with the draft.
  composerPrompt?: { prompt: AttachedPrompt };
  attached: AttachedPrompt | null;
  picked: string | null;
  newAgent: Agent | null;
  draft: string;
  attachments: Attachment[];
  attaching: boolean;
  // The session a message is being sent to, until the core shows it; "new" while its session starts.
  sending: string | null;
  pendingMessage: ChatEntry | null;
  beforeRevision: number;
  error: string | null;
  // What was pushed to each terminal session from this pane (ADR 0049), by its id: coxswain sees nothing else of its
  // conversation. state: sending, delivered, or why not.
  // ponytail: kept for the window only, so a reload forgets them; the core could keep them if that matters.
  pushes: Record<string, Push[]>;
};
export type Push = { text: string; state: "sending" | "delivered" | { error: string } };
const empty: Pane = {
  picked: null,
  newAgent: null,
  draft: "",
  attachments: [],
  attaching: false,
  attached: null,
  sending: null,
  pendingMessage: null,
  beforeRevision: -1,
  error: null,
  pushes: {},
};
const panes = new Map<number, Pane>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
export function setAgentPane(id: number, patch: Partial<Pane> | ((before: Pane) => Partial<Pane>)) {
  const before = panes.get(id) ?? empty;
  panes.set(id, { ...before, ...(typeof patch === "function" ? patch(before) : patch) });
  listeners.forEach((listener) => listener());
}
export const useAgentPane = (id: number) =>
  useSyncExternalStore(subscribe, () => panes.get(id) ?? empty);
export const agentPane = (id: number) => panes.get(id) ?? empty;

// Shows a push in the pane while it goes, then how it went (ADR 0049). The error, or null once delivered.
export async function trackPush(
  workspaceId: number,
  terminalId: string,
  text: string,
  push: () => Promise<unknown>,
): Promise<string | null> {
  const record = (change: (before: Push[]) => Push[]) =>
    setAgentPane(workspaceId, (before) => ({
      pushes: { ...before.pushes, [terminalId]: change(before.pushes[terminalId] ?? []) },
    }));
  const sent: Push = { text, state: "sending" };
  record((before) => [...before, sent]);
  const state: Push["state"] = await push().then(
    () => "delivered" as const,
    (e: Error) => ({
      error: e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ""),
    }),
  );
  record((before) => before.map((p) => (p === sent ? { ...p, state } : p)));
  return state === "delivered" ? null : state.error;
}
