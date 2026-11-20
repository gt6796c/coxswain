# 46. Adopting the user's worktrees

## Status

Accepted. Extends [ADR 0040](0040-local-repositories-and-optional-github.md) decision 3.

## Context

In a local repository, a branch checked out in one of the user's own worktrees can't be a workspace's (ADR 0040):
coxswain refuses it rather than move it. For someone else's PR that's right; a fresh worktree of coxswain's is what's
wanted. For the user's own work it isn't: the branch is checked out where they work on it, with their editor,
environment and uncommitted changes, and git won't check out one branch in two worktrees.

## Decision

1. **`COXSWAIN_ADOPT_WORKTREES` turns it on.** Unset, nothing changes.
2. **A branch checked out in another of the repository's worktrees is adopted**, wherever that worktree is: coxswain's
   path for the workspace's worktree (ADR 0005) becomes a symlink to it, so everything that follows from that path
   works unchanged. Its files, index and commits are left as they are. The repository's own checkout is never adopted;
   a branch checked out there is still refused.
3. **The link is followed again on every open.** If the user has removed that worktree or checked out another branch
   there, the link goes, and the workspace gets a worktree of coxswain's as usual.
4. **coxswain never updates an adopted worktree.** Auto-update from Remote is turned off on every open; Update from
   Remote still runs when the user asks, with the usual protection of local work. coxswain never moves, removes or
   prunes it.
5. **Language servers get the real path** (ADR 0034): they answer with real paths, and results outside the checkout
   are dropped.

## Alternatives considered

- **Worktree paths looked up from `git worktree list`** instead of following from the workspace. No symlinks, but
  every place that derives the path (ADR 0005) would become a git call.
- **The adopted path stored in the database.** No symlink, but it goes stale the same way, so it's checked on every
  open regardless, and it needs a migration.
- **A setting in the app.** More discoverable. An environment variable, like `COXSWAIN_USER_DATA`, keeps an opt-in
  for few users out of the UI.

## Consequences

- An adopted worktree is the user's own: an agent's edit there lands in their worktree, and a commit there is on their
  branch.
- A workspace that stops being adopted keeps auto-update off until the user turns it on.
- Only a local repository's worktrees can be adopted: a GitHub project's worktrees are made from coxswain's own clone
  (ADR 0008), which has none of the user's.
