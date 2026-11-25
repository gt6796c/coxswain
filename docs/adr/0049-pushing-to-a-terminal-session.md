# 49. Terminal sessions connected to coxswain, and pushing to them

## Status

Accepted. Carried in the fork. Extends ADR 0048 (the tools a terminal session pulls) with the other direction: coxswain
knows which terminal sessions are running and sends one a message. A spike is on `feat/terminal-channel` (71a9f25).

## Context

With ADR 0048 a terminal session reaches coxswain, never the other way: coxswain learns of a session only when it calls a
tool, and a comment the user leaves for it waits until the user goes to the terminal and says "read the review". The
features that come next need coxswain to start the conversation: select lines and "Review this with <session>", send a
batch of queued replies, answer a session's question from the decision inbox. For those, coxswain needs to know which
sessions are there and to put a message into one.

Claude Code has two ways in from outside, both checked against Claude Code 2.1.326:

- **A channel** (research preview): an MCP server that declares `capabilities.experimental["claude/channel"]` sends
  `notifications/claude/channel {content, meta}`, and the session gets a `<channel source=… …>` event, read as coming
  from the user's side. The session must be started with the server named in `--channels plugin:…` (servers on
  Anthropic's allowlist) or `--dangerously-load-development-channels server:…` (any other, after a prompt), and the
  organization's policy must allow channels (`channelsEnabled`). When it doesn't, Claude Code warns at start and drops
  the events silently. Nothing in `initialize` or anywhere the server can see says whether the channel was taken. A
  server that negotiates the newest MCP revision (2026-07-28) isn't registered as one, so the bridge answers 2025-06-18.
- **The session's inbox socket** (cross-session messaging, on by default since 2.1.224, no organization switch): Claude
  Code gives every MCP server it starts `CLAUDE_CODE_MESSAGING_SOCKET` and `CLAUDE_CODE_MESSAGING_TOKEN`, documented for
  a script posting to its own session. A connection writes `{"type": "auth", "token": …}` then
  `{"type": "user", "message": {"role": "user", "content": …}}`, one JSON object per line (the frame isn't documented;
  Claude Code's own example has it). The session gets it between tool calls, or as a new turn when idle, as "Another
  Claude session sent a message": a teammate's request, not the user's word. The user's `crossSessionInbound` setting
  may hold or refuse it.

coxswain won't be on Anthropic's allowlist, and few users will start sessions with a flag that says "dangerously", so the
inbox socket is the way in for nearly every session.

## Decision

1. **A session is connected from when it starts.** Its bridge (ADR 0048) connects to `<userData>/control.sock` when
   Claude Code initializes it, not at its first tool call, and keeps that connection open:
   `session {"protocol": 1, "session": <CLAUDE_CODE_SESSION_ID>, "name": …, "cwd": …, "account": …, "route": …,
   "pick": …}` (`protocol`: point 9; `pick`: point 2). coxswain answers
   `ready`. `account` is the Claude Code config folder it runs under (`CLAUDE_CONFIG_DIR`, else `~/.claude`), so one
   coxswain serves sessions of several Claude accounts; each account registers the bridge once
   (`claude mcp add -s user`). This connection only says the session is there; tool calls keep their own
   (ADR 0048 point 3), and connecting opens no workspace.
2. **Sessions are core state** (`src/core/terminal-sessions.ts`), in memory: who is connected now, nothing stored.
   Connecting, leaving, being renamed and picking another workspace emit a core event (ADR 0017), and the UI lists the
   sessions with their name, account, folder and the workspace their tool calls go to: their `use_workspace` pick
   (`{}` for none), in the hello and again as `{"pick": …}` whenever `use_workspace` or `remove_workspace` changes it,
   else the branch checked out in their folder, read when they connect. That is matched to a workspace coxswain already
   has, in the project whose repository holds the folder, and opens none; a session with no such workspace is listed
   with none. UX.md says where they show.
3. **A session is addressed by its id.** Its name (`set_session_name`, ADR 0048 point 7) is what the UI shows; the bridge
   may also read it, and whether the session is busy, from Claude Code's `<config>/sessions/<its parent pid>.json`. That
   file isn't documented, so the bridge reads it only to fill in what it would otherwise lack, and goes on without it.
   Two sessions with the same name, in two accounts, are told apart by account. A control line `push {"to": …}` takes a
   name only when one connected session has it.
4. **The bridge picks the route once, when it starts:**
   - `channel` when Claude Code's command line (its parent process) names this server (`coxswain`, or the name in
     `COXSWAIN_MCP_NAME` for a dev run's) in `--channels` or `--dangerously-load-development-channels`: the user asked
     for it for this session;
   - else `inbox` when `CLAUDE_CODE_MESSAGING_SOCKET` is set;
   - else `none`: the session is listed, and a push to it is refused with why (Claude Code before 2.1.224).

   The route is in the hello and shown in the list. Nothing is sent both ways, which would arrive twice.

5. **A push is one line each way.** coxswain writes `{"push": {"id", "text", "meta"}}` on the session's connection; the
   bridge answers `{"ack": id}` once the channel event is sent or the inbox has the message, or
   `{"nack": id, "error": …}`. After 5 s without an answer the push fails. An ack says Claude Code has it, not that the
   model has read it. On the inbox route the text starts `From coxswain, sent by the user (<meta as k=v>):`, since the
   session would otherwise take it for another session's; on a channel, meta goes as the event's attributes. Meta keys are
   identifiers and values strings, which is all a channel keeps.
6. **coxswain pushes only on something the user does**: a button, a command, `push` on the control socket from a script
   the user runs. Nothing is pushed on coxswain's own initiative, so "sent by the user" stays true, and replies still
   queue (ADR 0048 point 7) until the user sends them.
7. **Nothing waits for a session that isn't there.** A push to a session that isn't connected fails at once, naming
   those that are; nothing is queued or stored. A bridge that loses coxswain tries again after 1 s, then every 2, 4, 8
   and 10 s while coxswain stays away, so sessions come back by themselves when coxswain restarts, saying their name
   again in the hello. A second bridge for the same session (`/mcp` reconnect, a resumed session) takes its place, and
   the old one is told `replaced` and stops connecting. For a few seconds after coxswain starts, the list says sessions
   are still connecting rather than that there are none.
8. **The control socket stays local**: `0600`, in the user's data folder. Any process of the user's can already post to
   a session's inbox; the socket adds only coxswain's list of sessions. coxswain never looks up sessions whose bridge
   didn't connect, so it pushes only to sessions started with coxswain's bridge.
9. **The hello says which protocol the bridge speaks**, a number raised whenever the lines on this connection change.
   A session keeps the bridge it started with, even after coxswain is updated, so a long-running session may speak an
   older one. coxswain answers a bridge it can't serve `outdated` instead of `ready` and keeps the connection, so the
   session is listed as one to restart while it runs, and a push to it is refused with that. A hello with no number is
   from the spike, and gets the same.

## Alternatives considered

- **Channel only**: blocked by organization policy where it matters to us today, and needs a frightening flag
  everywhere else; most sessions could never be pushed to.
- **Channel and inbox both, every time**: the session gets every push twice when the channel works.
- **Checking the channel on its first push** (ask the model to confirm with a tool call; no confirmation in ~30 s means
  blocked, so resend through the inbox and remember it per account): it would catch a blocked channel instead of
  dropping pushes, but a session busy in a long turn looks blocked and gets the push twice. Worth it if channels become
  common; the flag check is enough while they're rare.
- **Finding sessions from Claude Code's `sessions/*.json`** instead of bridges connecting: undocumented, says nothing of
  which workspace a session works on, and would let coxswain push into sessions that never opted in.
- **Waking the session per comment** (forwarding each reply as the user writes it): rejected in ADR 0048 point 7 for the
  same reason, the session reacts to each before the user has finished.
- **Pushing instead of the agent pane's ACP sessions** (ADR 0018), so coxswain has one way to talk to agents: a push is
  text into a session coxswain doesn't run. coxswain doesn't see the reply stream, the tool calls, permission requests
  or where a turn ends, so it couldn't cancel, steer, queue, show agent status or take a turn diff; the answer comes back
  only if the session writes it with coxswain's tools. Both ways in are Claude Code's, so Codex and Gemini would be lost.
  The two stay side by side behind one entry point instead: what is sent to an agent (an ask, a question, "Review this
  with…") goes to the pane's session over ACP or to a connected terminal session as a push, whichever the user picks.

## Consequences

- On the inbox route a push reads as a teammate's request. The session weighs it as one: it may ask the user before
  doing anything outward a push asks for, and it can't be told something only the user may say. A channel doesn't have
  this limit.
- A session started with the channel flag in an organization that blocks channels loses its pushes silently, after
  Claude Code's warning at start. The list shows its route as `channel`, so the user can tell.
- `crossSessionInbound: hold` or `refuse` holds or drops inbox pushes after the ack; coxswain can't tell.
- The list shows only sessions whose bridge is running, i.e. started after the bridge was registered for their account.
- The `sessions/<pid>.json` read may break with any Claude Code release; the name from `set_session_name` doesn't.
- The bridge now connects for every session in every folder; one outside coxswain's repositories (ADR 0048 point 2)
  shows in the list with no workspace.
- A branch checked out in a session's folder after it connected isn't seen until it connects again, so the session
  stays listed at the old branch's workspace. Worktrees rarely change branch.
- The spike's `COXSWAIN_PUSH` variable goes; the route comes from the command line.
- A push in flight when coxswain quits may or may not have reached the session, and nothing records which. Pushes are
  rare and each is the user's, who can see in the terminal.
- A push in the seconds after coxswain starts, before the session's bridge is back, fails as not connected.
- A bridge goes back only to the coxswain it was registered for (its `COXSWAIN_USER_DATA`): a session on the installed
  app doesn't show in a dev run, or the other way round.
