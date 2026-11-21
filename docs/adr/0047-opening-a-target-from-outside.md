# 47. Opening a PR or branch from outside the app

## Status

Accepted. Carried in a fork, not proposed upstream.

## Context

A review often starts somewhere else: a terminal, a script, a link in chat. Picking the project, then the PR or the
branch, in the app every time is slow, and a script can't do it at all. The app had no way to be told what to open:
no deep link, no single-instance lock, no command-line handling.

## Decision

1. **A target** is a PR or a branch of a project: `https://github.com/owner/name/pull/N`, `owner/name#N`,
   `owner/name@branch`, `/path#N` or `/path@branch`. `owner/name` is coxswain's clone (ADR 0008), added if new; a
   `/path` is the local repository there (ADR 0040), added or re-read if known. A branch must exist (its own or on
   origin); a typo isn't made into a new branch.
2. **At launch**, `COXSWAIN_OPEN=<target>` opens it before the window loads, so the window starts on it. Like the other
   settings that shape a run (`COXSWAIN_USER_DATA`), it's an environment variable.
3. **Into a running app**, a line written to `<userData>/control.sock`, a Unix socket only the user can open (0600),
   opens the target and answers one line, `opened …` or `error: …`. One target per connection.
4. **Opening makes the project and workspace the latest opened**; nothing tells the window to navigate. A window on
   another project follows to the target's project and shows its latest workspace, the target; in the same project the
   target's tab appears and the shown workspace stays.
5. **All of it is in `src/core/open-target.ts`**, wired by one line in `src/main/index.ts`, so the change is cheap to
   carry on top of upstream.

## Alternatives considered

- **Single-instance lock with argv** (`app.requestSingleInstanceLock`, `second-instance`): Electron's usual way. A dev
  run would start a second `pnpm dev`, building again, just to hand the target over, and it spreads through startup.
- **A `coxswain://` URL scheme**: registers poorly for a dev build, and two coxswains with separate data would claim the
  same scheme.
- **Navigating the window to the target**: needs a message to the renderer and a change to App.tsx, a busy file; the
  tab appearing is enough.

## Consequences

- A script can open a review: `printf '%s\n' 'owner/name#12' | nc -U -w 60 ~/Library/Application\ Support/coxswain/control.sock`.
  macOS `nc` needs `-w` to wait for the answer after its input ends; the socket is half-open so the answer still goes.
- macOS limits a socket path to 103 bytes; a deeper `COXSWAIN_USER_DATA` gets no socket (logged), only `COXSWAIN_OPEN`.
- Each userData has its own socket, so two coxswains with separate data each take their own targets.
- Two apps on the same userData: the second takes the socket over (no lock).
- A local repository's path can't contain `#` or `@`.
- Not in the glossary, README or devlog, to keep the change to new files.
