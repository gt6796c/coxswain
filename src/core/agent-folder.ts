import { statSync } from "node:fs";
import { isAbsolute, join, normalize, sep } from "node:path";

// ADR 0018, decision 14: the agent pane's sessions start in COXSWAIN_AGENT_FOLDER, a folder of the checkout such as a
// monorepo's backend/ with its own CLAUDE.md, AGENTS.md and .claude/, so the agent loads that folder's instructions,
// skills and settings. The checkout is added as a directory the agent may read too, and coxswain's tools keep taking
// repository-relative paths. Unset, outside the checkout, or a folder this checkout doesn't have: the checkout, as
// before.
// ponytail: one folder for the whole run, read from the environment; choosing per session would take a picker in the
// pane and the folder stored with each session.
export type AgentPlace = { cwd: string; additionalDirectories?: string[]; note?: string };

export function agentPlace(
  root: string,
  folder = process.env.COXSWAIN_AGENT_FOLDER ?? "",
): AgentPlace {
  const relative = normalize(folder.trim()).replace(/[/\\]+$/, "");
  const outside = isAbsolute(relative) || relative === ".." || relative.startsWith(`..${sep}`);
  if (!relative || relative === "." || outside) return { cwd: root };
  const cwd = join(root, relative);
  if (!isDirectory(cwd)) return { cwd: root };
  return {
    cwd,
    additionalDirectories: [root],
    note:
      `Your working directory is the repository's ${relative}/ folder; the repository root is ${root}. ` +
      "Paths given to and returned by coxswain's tools are relative to the repository root.",
  };
}

// The pane's sessions, those given coxswain's tools, run in the agent folder. Background jobs have no tools and stay on
// the checkout, like git, the language servers and snapshots.
export const sessionPlace = (o: { cwd: string; mcp?: unknown[] }): AgentPlace =>
  o.mcp?.length ? agentPlace(o.cwd) : { cwd: o.cwd };

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
