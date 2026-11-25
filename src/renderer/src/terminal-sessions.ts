import { useQuery } from "@tanstack/react-query";
import { match } from "ts-pattern";
import type { CanvasSend } from "../../core/terminal-sends";
import type { TerminalSession } from "../../core/terminal-sessions";
import { agentPane, trackPush } from "./agent-pane";
import { core } from "./queries";

// ADR 0049: the terminal sessions connected to coxswain now, as L1's tabs, L4's picker and ⌘K show them.

// The agent pane's pick of a terminal session, beside its agent sessions' ids.
export const terminalPick = (s: TerminalSession) => `terminal:${s.session}`;
export const pickedTerminal = (picked: string | null) =>
  picked?.startsWith("terminal:") ? picked.slice("terminal:".length) : null;

export function useTerminalSessions() {
  const data = useQuery(core("listTerminalSessions")).data;
  return { sessions: data?.sessions ?? [], settling: data?.settling ?? false };
}

// Its name, or the start of its id until it has one.
export const terminalName = (s: TerminalSession) => s.name ?? `Session ${s.session.slice(0, 8)}`;

// Why a push to it would be refused, or null when it takes them.
export const cantTake = (s: TerminalSession) =>
  match(s)
    .returnType<string | null>()
    .with({ outdated: true }, () => "Restart this session to connect")
    .with({ route: "none" }, () => "No inbox: Claude Code before 2.1.224")
    .otherwise(() => null);

// The names of the sessions pointing at each workspace, for its tab.
export function terminalsByWorkspace(sessions: TerminalSession[]) {
  const by = new Map<number, string[]>();
  for (const s of sessions)
    if (s.workspace) by.set(s.workspace.id, [...(by.get(s.workspace.id) ?? []), terminalName(s)]);
  return by;
}

// What the canvas sends to the agent goes to the terminal session the agent pane shows, when it shows one, and is
// listed there. null when it doesn't, so the caller starts a turn as before; else the error, or null once delivered.
// label: how the pane lists it.
export function sendToPicked(
  workspaceId: number,
  label: string,
  what: CanvasSend,
): Promise<string | null> | null {
  const terminal = pickedTerminal(agentPane(workspaceId).picked);
  if (!terminal) return null;
  return trackPush(workspaceId, terminal, label, () =>
    window.coxswain.sendToTerminal(terminal, what),
  );
}

// The Claude account it runs under, by its config folder's name (~/.claude, ~/.claude-work).
export const accountName = (s: TerminalSession) => s.account.split("/").pop() ?? s.account;
