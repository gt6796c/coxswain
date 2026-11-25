import { type ReactNode, useEffect, useRef, useState } from "react";
import { match, P } from "ts-pattern";
import type { TerminalSession } from "../../core/terminal-sessions";
import { setAgentPane, trackPush, useAgentPane } from "./agent-pane";
import { TextArea } from "./components/field";
import { ArrowUpIcon } from "./components/icons";
import { cn, divider, muted, titleBar } from "./components/styles";
import { ErrorText } from "./components/text";
import { cantTake, terminalName } from "./terminal-sessions";

// How long a terminal session that left stays picked, in case it connects again (its bridge retries every 1–10 s).
const goneMs = 30_000;

// L4 with a terminal session picked (ADR 0049): coxswain can't see its conversation, so the pane shows what was pushed
// to it from here, each delivered or not, and the composer pushes to it. It answers in coxswain's threads, with its
// tools, or in its terminal.
export function TerminalPane(props: {
  workspaceId: number;
  terminalId: string;
  // null: it isn't connected now.
  session: TerminalSession | null;
  header: (name: string) => ReactNode;
}) {
  const { workspaceId, terminalId, session } = props;
  const pushes = useAgentPane(workspaceId).pushes[terminalId] ?? [];
  const [draft, setDraft] = useState("");
  // Its name while it's gone: the last one seen.
  const seen = useRef<{ id: string; name: string } | null>(null);
  if (session) seen.current = { id: terminalId, name: terminalName(session) };
  const name = seen.current?.id === terminalId ? seen.current.name : "Terminal session";
  useEffect(() => {
    if (session) return;
    const timer = setTimeout(() => setAgentPane(workspaceId, { picked: null }), goneMs);
    return () => clearTimeout(timer);
  }, [session, workspaceId]);

  const refused = session
    ? cantTake(session)
    : `${name} disconnected. Waiting for it to connect again…`;
  const send = async () => {
    const text = draft.trim();
    if (!text || refused) return;
    setDraft("");
    await trackPush(workspaceId, terminalId, text, () =>
      window.coxswain.pushToSession(terminalId, text),
    );
  };

  return (
    <>
      <div className={cn(titleBar, "gap-1 border-b px-1.5", divider)}>{props.header(name)}</div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className="flex flex-1 flex-col gap-3 p-4">
          {pushes.length === 0 && (
            <div className={cn("m-auto max-w-64 text-center text-xs", muted)}>
              What you send goes to {name} in its terminal. It answers in coxswain's threads, or
              there.
            </div>
          )}
          {pushes.map((p, i) => (
            <div key={i} className="flex max-w-[90%] shrink-0 flex-col items-end gap-1 self-end">
              <div className="rounded-xl bg-neutral-100 px-4 py-3 whitespace-pre-wrap select-text [overflow-wrap:anywhere] dark:bg-neutral-800">
                {p.text}
              </div>
              {match(p.state)
                .with("sending", () => <span className={cn("text-xs", muted)}>Sending…</span>)
                .with("delivered", () => <span className={cn("text-xs", muted)}>Delivered</span>)
                .with({ error: P.select() }, (error) => <ErrorText>{error}</ErrorText>)
                .exhaustive()}
            </div>
          ))}
        </div>
      </div>
      {refused && <div className={cn("px-4 pb-2 text-xs", muted)}>{refused}</div>}
      <div className="relative mx-3 mb-3 flex flex-col rounded-xl border border-neutral-300 bg-white focus-within:border-neutral-400 dark:border-neutral-700 dark:bg-neutral-900 dark:focus-within:border-neutral-600">
        <TextArea
          bare
          value={draft}
          disabled={!!refused}
          onChange={(e) => setDraft(e.target.value)}
          onSubmit={send}
          rows={2}
          placeholder={`Send to ${name}…`}
          className="px-4 pt-4 text-sm"
        />
        <div className="flex items-center justify-end px-3 pb-3">
          <button
            title="Send (Enter; Shift+Enter for a new line)"
            aria-label="Send"
            disabled={!draft.trim() || !!refused}
            className="flex size-7 shrink-0 items-center justify-center rounded-full bg-neutral-900 text-white hover:bg-neutral-700 disabled:bg-neutral-200 disabled:text-neutral-400 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300 dark:disabled:bg-neutral-800 dark:disabled:text-neutral-500"
            onClick={send}
          >
            <ArrowUpIcon />
          </button>
        </div>
      </div>
    </>
  );
}
