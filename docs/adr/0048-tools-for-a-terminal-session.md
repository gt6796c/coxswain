# 48. coxswain's tools for an agent session in the user's terminal

## Status

Accepted. Carried in a fork, not proposed upstream. Builds on ADR 0047's control socket.

## Context

The agent pane is coxswain's own session, scoped to reviewing (ADR 0023). A user who already works with a coding agent in
a terminal, one session per worktree, wants that session to write the review into coxswain (a Guide with findings,
ADR 0026) and to read and answer the comments they leave on it, with no second agent that knows nothing of the work.
coxswain's tools are served only to pane sessions, on a port that changes every launch.

## Decision

1. **A bridge**, `scripts/coxswain-mcp.mjs`, is a stdio MCP server the user registers once
   (`claude mcp add -s user coxswain -- node <path>`). It has no dependencies and keeps no state but its connection.
2. **Tools are listed from a catalog**, `<userData>/terminal-tools.json`, written by the app when it starts and when a
   terminal session opens a workspace: the tools and the local repositories. A session lists tools once, when it
   starts, maybe before the app; the bridge lists them only inside a repository coxswain has (by its main checkout), so
   other sessions get none. It tells the session when the catalog changes (`tools/list_changed`).
3. **The first tool call connects** to `<userData>/control.sock` with `mcp {"cwd": …}`. The app opens the branch checked
   out there in that repository, as a target (ADR 0047): added if new, and adopted when it's the user's own worktree
   (ADR 0046). It answers `ready <workspace>` (naming the folder its code is in) or `error: …`; then one JSON-RPC message
   per line each way, on that connection. All traffic goes over the socket, so the same bridge could serve a session on
   another machine through a forwarded socket. A directory on the branch the repository's workspaces start from (its
   main checkout) is refused with what to do instead: that branch has no changes to review.
4. **`use_workspace {branch | pr}` picks another workspace**, for a session that runs in the main checkout or reviews a
   branch other than its own. The bridge answers it, not the app: it keeps the pick and sends it in every hello
   (`mcp {"cwd": …, "branch": …}` or `"pr": …`), so the pick outlasts an app restart. It connects again with the new
   pick, and keeps the old one if coxswain refuses it. With neither, the session goes back to its directory's branch. The
   answer names the folder the workspace's code is in, which the session reads and runs from then on. The bridge's
   directory is where the session started, so a session that moved since (EnterWorktree, `cd`) still works on that
   branch: `start_guide`'s answer names the workspace, and says to switch if it isn't the one under review. The bridge also
   says the session's name (`set_session_name`, point 7) again on each new connection, since the app keeps it per
   connection.
5. **The tools** are the pane's view tools less `publish_guide`, plus `read_review` (open anchored threads whose last
   entry isn't an agent's: the user's comments and their replies to findings, with thread ids and code; with `all`, the
   agent's own open threads too, so a second review can skip findings already there and resolve those that no longer
   hold),
   `reply_to_thread` (an answer entry), `resolve_thread` (not a thread on GitHub: the user resolves those there),
   `show_thread` and `finish_guide`. A pane turn ending marks its views written (glossary "Being written"); a terminal
   session has no turn coxswain sees, so it calls `finish_guide`.
6. **`show_thread` moves the window** to a thread, by its id or by words only its first comment has (a review's label,
   `[G1-L2]`), as picking it in the sidebar does. The core hands the thread's first entry to a listener
   (`src/core/show-thread.ts`); the main process sends it to the window (`src/main/show-thread.ts`), which comes forward
   without the keyboard, so the user keeps typing in the terminal.
7. **Replies on a session's findings wait for it.** The session names itself once (`set_session_name`, its name as
   ListAgents shows it; nothing in its environment says it), and each finding or explanation it adds afterwards keeps
   that name in settings (`terminal.replies.<thread>`, no migration). A reply on such a thread stays a note instead of
   going to the agent pane, as replies on agent threads otherwise do (`src/core/terminal-replies.ts`). It waits in
   `read_review`, with the user's other comments, until the user tells the session to take them; the session answers
   each with `reply_to_thread`. Queued, not forwarded one by one: a session woken per comment reacts to each
   before the user has finished commenting.
8. **All of it is in new files** (`src/core/terminal-tools.ts`, `terminal-replies.ts`, `show-thread.ts` in core, main
   and renderer, the bridge) plus the socket's dispatch in `open-target.ts`. The MCP answering and argument check are a
   copy of `agents.ts`'s. `show_thread` needs a one-line hook in each of `src/main/index.ts` and `App.tsx`, and a
   listener in the preload; queued replies need a line in each of `review.ts`'s `askQuestion` and `sendThread`.

## Alternatives considered

- **`claude mcp add --transport http <url>` per workspace**: the URL holds a port that changes every launch, and every
  worktree needs its own registration.
- **Serving the terminal tools on the HTTP tool server**: needs changes in `agents.ts`, which upstream edits often, and a
  port a session on another machine can't learn.
- **Working in the agent pane**: it's deliberately limited to reviewing, and it's a second session apart from the one
  that did the work.

## Consequences

- The user comments as a note (the composer's toggle off Agent); Agent sends it to the pane's session instead. The
  terminal session sees comments when asked (`read_review`): coxswain doesn't wake it, the user does.
- A reply on a session's finding gets no answer in coxswain until the session takes the comments; the reply box still
  reads "Ask the agent…".
- A session in the user's own worktree needs adoption (ADR 0046); without it coxswain refuses a branch checked out
  elsewhere.
- Opening a workspace makes its project the latest, so a window on another project follows it (ADR 0047).
- `finish_guide` ends every view being written in the workspace, as a pane turn ending does.
- A copy of the MCP answering to keep in step if upstream changes how tools are called or checked.
- A directory not on this machine is refused; a remote session would name its repository's remote and branch instead.
- A session that picked a workspace reads code from that workspace's folder, not its own directory; `use_workspace`'s
  answer is the only place that says so.
- Not in the glossary, README or devlog, to keep the change to new files.
