import { useGlassOcclusion } from "./components/NativeToolbar";
import { useQuery } from "@tanstack/react-query";
import { match, P } from "ts-pattern";
import { useState } from "react";
import { Input } from "./components/field";
import { ListRow } from "./components/layout";
import { cn, divider, muted, selectable } from "./components/styles";
import { fuzzyFilter } from "./fuzzy";
import { core } from "./queries";
import type { TerminalSession } from "../../core/terminal-sessions";
import { accountName, cantTake, terminalName, useTerminalSessions } from "./terminal-sessions";

// Something the user can do, by id: from the command palette, the native menu (by its id) or a button.
export type Action = {
  id: string;
  title: string;
  shortcut?: string; // shown next to it, e.g. ⌘B; the native menu owns the key
  enabled?: boolean; // false: left out of the palette and not run
  run: () => void;
};

// The command palette (⌘K, or ⌘⇧O for Open Quickly): type part of a file's path and Enter opens it, start with > to
// find an action and run it, or with @ for the terminal sessions connected now (ADR 0049; Terminal Sessions…), where
// Enter opens one's workspace with it picked in the agent pane. Esc or a click outside closes it.
export function CommandPalette(props: {
  workspaceId: number | undefined;
  actions: Action[];
  initialQuery: string; // ">" for actions, "@" for terminal sessions, "" for files
  onOpen: (path: string) => void;
  onTerminal: (session: TerminalSession) => void;
  onClose: () => void;
}) {
  useGlassOcclusion();
  const [query, setQuery] = useState(props.initialQuery);
  const [current, setCurrent] = useState(0);
  const acting = query.startsWith(">");
  const terminal = query.startsWith("@");
  const files = useQuery({
    ...core("listWorktreeFiles", props.workspaceId ?? 0),
    enabled: !!props.workspaceId && !acting && !terminal,
  }).data;
  const terminals = useTerminalSessions();
  const accounts = new Set(terminals.sessions.map((s) => s.account)).size;
  type Row = { key: string; title: string; shortcut?: string; pick: () => void };
  const rows = match({ terminal, acting, files })
    .returnType<Row[]>()
    .with({ terminal: true }, () =>
      fuzzyFilter(terminals.sessions, query.slice(1), terminalName).map((s) => ({
        key: s.session,
        title: [
          terminalName(s),
          s.workspace?.label ?? "No workspace",
          accounts > 1 && accountName(s),
        ]
          .filter(Boolean)
          .join(" · "),
        shortcut: cantTake(s) ?? undefined,
        // One with no workspace stays: the row says why.
        pick: () => {
          if (!s.workspace) return;
          props.onClose();
          props.onTerminal(s);
        },
      })),
    )
    .with({ acting: true }, () =>
      fuzzyFilter(
        props.actions.filter((a) => a.enabled !== false),
        query.slice(1),
        (a) => a.title,
      ).map((a) => ({
        key: a.id,
        title: a.title,
        shortcut: a.shortcut,
        pick: () => {
          props.onClose();
          a.run();
        },
      })),
    )
    .with({ files: { status: "ok", paths: P.select() } }, (paths) =>
      fuzzyFilter(paths, query, (p) => p).map((p) => ({
        key: p,
        title: p,
        pick: () => props.onOpen(p),
      })),
    )
    .otherwise(() => []);
  const empty = match({ acting, terminal, workspaceId: props.workspaceId, files })
    .with({ terminal: true }, () =>
      terminals.sessions.length
        ? "No matching terminal sessions"
        : "No terminal sessions are connected",
    )
    .with({ acting: true }, () => "No matching actions")
    .with({ workspaceId: P.union(undefined, 0) }, () => "No workspace. Type > for actions")
    .with({ files: undefined }, () => "Loading…")
    .with({ files: { message: P.string.select() } }, (message) => message)
    .otherwise(() => "No matching files");

  return (
    <div className="fixed inset-0 z-50 flex justify-center px-6 pt-24" onMouseDown={props.onClose}>
      <div
        className={cn(
          "flex h-fit max-h-[min(24rem,calc(100vh-112px))] w-full max-w-xl flex-col rounded-xl border bg-white p-3 shadow-xl dark:bg-neutral-900",
          divider,
        )}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <Input
          autoFocus
          value={query}
          placeholder="Open a file in the workspace, type > for actions or @ for terminal sessions"
          onChange={(e) => {
            setQuery(e.target.value);
            setCurrent(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") props.onClose();
            else if (e.key === "Enter") rows[current]?.pick();
            else if (e.key === "ArrowDown") setCurrent((i) => Math.min(i + 1, rows.length - 1));
            else if (e.key === "ArrowUp") setCurrent((i) => Math.max(i - 1, 0));
            else return;
            e.preventDefault();
          }}
        />
        <div className="mt-2 min-h-0 overflow-y-auto">
          {terminal && terminals.settling && (
            <div className={cn("px-2 py-1", muted)}>Sessions are reconnecting…</div>
          )}
          {rows.map((r, i) => (
            <ListRow
              key={r.key}
              ref={(el) => void (i === current && el?.scrollIntoView({ block: "nearest" }))}
              className={cn(i === current && selectable(true))}
              onClick={r.pick}
            >
              <span className="flex justify-between gap-4">
                <span className="truncate">{r.title}</span>
                {r.shortcut && <span className={cn("shrink-0", muted)}>{r.shortcut}</span>}
              </span>
            </ListRow>
          ))}
          {!rows.length && <div className={cn("px-2 py-1", muted)}>{empty}</div>}
        </div>
      </div>
    </div>
  );
}
