import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import type { Socket } from "node:net";
import { dirname, join } from "node:path";
import type { Interface } from "node:readline";
import { promisify } from "node:util";
import type { McpTool } from "./agents";
import type { Db } from "./db";
import { addEntry, liveEntries, type ReviewEntry } from "./entries.ts";
import { currentMergeBase, openWorktree } from "./git.ts";
import { openTarget } from "./open-target.ts";
import { listProjects } from "./projects.ts";
import { emit } from "./events.ts";
import { anchored, byAgent, describe, fence, who } from "./thread-context.ts";
import { turnEnded, viewTools } from "./views.ts";

// ADR 0048: coxswain's view tools for a Claude Code session in the user's terminal, reached through a bridge
// (scripts/coxswain-mcp.mjs) on the control socket (ADR 0047). The session says where it runs; the workspace is that
// repository's branch, opened like a target.

const run = promisify(execFile);

// The workspace for a directory on this machine: the branch checked out there, in the repository it belongs to (added
// as a local repository if it's new), opened so its diff and threads are known.
// ponytail: a directory not on this machine (an agent on another host, through a forwarded socket) is refused; it
// could name its repository's remote and branch instead.
export async function terminalWorkspace(
  db: Db,
  cwd: string,
): Promise<{ workspaceId: number; label: string }> {
  const git = (...args: string[]) =>
    run("git", args, { cwd }).then(
      (r) => r.stdout.trim(),
      () => null,
    );
  const common = await git("rev-parse", "--path-format=absolute", "--git-common-dir");
  if (!common) throw new Error(`${cwd} isn't in a git repository on this machine`);
  const branch = await git("symbolic-ref", "--short", "-q", "HEAD");
  if (!branch) throw new Error(`${cwd} has no branch checked out`);
  const { project, workspace } = await openTarget(db, {
    project: { path: dirname(common) },
    branch,
  });
  if (currentMergeBase(workspace.id) === undefined) {
    const opened = await openWorktree(db, workspace.id);
    if (opened.status !== "ok")
      throw new Error("message" in opened ? opened.message : opened.status);
  }
  return { workspaceId: workspace.id, label: `${project.name}: branch ${workspace.branch}` };
}

const closedTool = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

// The view tools, less publish_guide (only coxswain's own Guide updates call it), and what a session outside coxswain
// needs besides: the user's comments, answering them, and saying when the Guide is done.
export function terminalTools(db: Db, workspaceId: number): McpTool[] {
  const thread = async (id: number) => {
    const root = await db
      .selectFrom("entries")
      .select(["id", "parent_id", "github_thread_id"])
      .where("id", "=", id)
      .where("workspace_id", "=", workspaceId)
      .executeTakeFirst();
    if (!root || root.parent_id !== null)
      throw new Error(`No thread ${id} here. Use a thread id read_review gives.`);
    return root;
  };
  return [
    ...viewTools(db, workspaceId).filter((t) => t.name !== "publish_guide"),
    {
      name: "read_review",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      description:
        "The user's open review threads in coxswain that wait on you: their comments on the diff, on the Guide and on your findings, each with its thread id, where it points and the code there. Call it when the user says they commented, or asks you to address their comments. With all, also the open threads where an agent spoke last, such as findings of an earlier review: read them before adding findings, so you don't add one that's already there.",
      inputSchema: {
        type: "object",
        properties: {
          all: {
            type: "boolean",
            description: "Also the open threads where an agent spoke last (default false)",
          },
        },
      },
      call: async (args: { all?: boolean }) =>
        reviewText(await liveEntries(db, workspaceId), args?.all === true),
    },
    {
      name: "reply_to_thread",
      annotations: closedTool,
      description:
        "Answer a thread from read_review in coxswain, where the user reads it: what you found, or what you changed and where, as you'd reply to a review comment.",
      inputSchema: {
        type: "object",
        properties: { thread_id: { type: "integer" }, body: { type: "string" } },
        required: ["thread_id", "body"],
      },
      call: async (args: { thread_id: number; body: string }) => {
        await thread(args.thread_id);
        await addEntry(db, "answer", { workspaceId, body: args.body, parentId: args.thread_id });
        return `Replied in thread ${args.thread_id}.`;
      },
    },
    {
      name: "resolve_thread",
      annotations: closedTool,
      description:
        "Mark a thread from read_review settled, once the change it asks for is made or the user agreed in it.",
      inputSchema: {
        type: "object",
        properties: { thread_id: { type: "integer" } },
        required: ["thread_id"],
      },
      call: async (args: { thread_id: number }) => {
        const root = await thread(args.thread_id);
        if (root.github_thread_id)
          return `Thread ${args.thread_id} is a review thread on GitHub: the user resolves it there.`;
        // As review.ts resolveThread does for a thread not on GitHub (that one imports agents.ts, which tests can't load).
        await db
          .updateTable("entries")
          .set({ resolved_at: new Date().toISOString() })
          .where("id", "=", args.thread_id)
          .execute();
        emit({ workspaceId, what: "entries" });
        return `Resolved thread ${args.thread_id}.`;
      },
    },
    {
      name: "finish_guide",
      annotations: closedTool,
      description:
        "Call once the Guide's last section is written (after start_guide and write_section). Until then coxswain holds its automatic Guide updates, so they don't replace your Guide.",
      inputSchema: { type: "object", properties: {} },
      call: async () => {
        turnEnded(workspaceId);
        return "The Guide is finished. coxswain updates it automatically again when the code changes.";
      },
    },
  ];
}

// Open anchored threads whose last entry isn't the agent's, each with its id, as read_review gives them. With all, the
// agent's own too (its findings nobody answered), so a new review can be checked against the one already there.
export function reviewText(entries: ReviewEntry[], all = false): string {
  const threads = entries
    .filter((e) => anchored(e) && !e.parentId && !e.resolvedAt)
    .map((root) => [root, ...entries.filter((e) => e.parentId === root.id)])
    .filter((t) => all || !byAgent(t[t.length - 1]));
  if (!threads.length) return all ? "No open thread." : "No open thread waits on you.";
  const parts = threads.map(([root, ...replies]) => {
    const changed =
      root.state !== "outdated"
        ? ""
        : root.now
          ? `\nThese lines have changed since; they now read:\n${fence(root.now)}\nCheck the comment still applies.`
          : "\nThese lines have changed since. Check the comment still applies.";
    const lines = [root, ...replies].map((e) => `${who(e)}: ${e.body}`);
    return `Thread ${root.id}, on ${describe(root)}${changed}\n${lines.join("\n")}`;
  });
  const legend = `"Me" is the user, "You" an agent of this workspace (you, or coxswain's own), "@name" a reviewer on GitHub.`;
  return all
    ? `${threads.length} open thread(s), oldest first, those where "You" spoke last included. ${legend} Resolve with resolve_thread a finding of yours that no longer holds, replying first with why.\n\n${parts.join("\n\n")}`
    : `${threads.length} open thread(s) wait on you, oldest first. ${legend} Answer each with reply_to_thread, and resolve_thread the settled ones.\n\n${parts.join("\n\n")}`;
}

// ponytail: the MCP answering and argument check below copy agents.ts's toolServer and mismatch, so this file touches
// no upstream code (re-patchability). Copy again if upstream changes how its tools are called or checked.
type McpMessage = {
  id?: string | number;
  method?: string;
  params?: { name?: string; arguments?: unknown };
};

// The JSON-RPC reply to one MCP message, or null for a notification. initialize and ping are the bridge's own.
async function answerMcp(tools: McpTool[], msg: McpMessage): Promise<object | null> {
  if (msg.id === undefined) return null;
  const reply = (r: object) => ({ jsonrpc: "2.0", id: msg.id, ...r });
  if (msg.method === "tools/list") return reply({ result: { tools: listedTools(tools) } });
  if (msg.method !== "tools/call")
    return reply({ error: { code: -32601, message: `No method ${msg.method}` } });
  const tool = tools.find((t) => t.name === msg.params?.name);
  const args = msg.params?.arguments ?? {};
  const problem = !tool ? `No tool ${msg.params?.name}` : mismatch(tool.inputSchema, args, "input");
  const text = problem
    ? `${problem}. Call ${msg.params?.name} again with all of it.`
    : await tool!.call(args as never).catch((e: Error) => ({ error: e.message }));
  const isError = !!problem || typeof text !== "string";
  return reply({
    result: {
      isError,
      content: [{ type: "text", text: typeof text === "string" ? text : text.error }],
    },
  });
}

const listedTools = (tools: McpTool[]) =>
  tools.map(({ name, description, inputSchema, annotations }) => ({
    name,
    description,
    inputSchema,
    ...(annotations && { annotations }),
  }));

type Schema = {
  type?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  enum?: readonly unknown[];
};
function mismatch(s: Schema, v: unknown, at: string): string | null {
  if (s.enum && !s.enum.includes(v))
    return `${at} must be one of ${s.enum.map((e) => JSON.stringify(e)).join(", ")}`;
  if (s.type === "object") {
    if (typeof v !== "object" || v === null || Array.isArray(v)) return `${at} must be an object`;
    const o = v as Record<string, unknown>;
    for (const k of s.required ?? []) if (!(k in o)) return `${at}.${k} is missing`;
    for (const [k, p] of Object.entries(s.properties ?? {})) {
      const m = k in o ? mismatch(p, o[k], `${at}.${k}`) : null;
      if (m) return m;
    }
  } else if (s.type === "array") {
    if (!Array.isArray(v)) return `${at} must be an array`;
    for (const [i, x] of v.entries()) {
      const m = mismatch(s.items ?? {}, x, `${at}[${i}]`);
      if (m) return m;
    }
  } else if (s.type === "integer" ? !Number.isInteger(v) : s.type && typeof v !== s.type) {
    return `${at} must be ${s.type === "integer" ? "an integer" : `a ${s.type}`}`;
  }
  return null;
}

// <userData>/terminal-tools.json: the tools and the local repositories, for the bridge to list before it has a
// workspace (a session lists tools once, when it starts, maybe before the app) and only in those repositories.
export async function writeCatalog(db: Db, userData: string) {
  const projects = (await listProjects(db)).flatMap((p) => (p.path ? [p.path] : []));
  const catalog = { tools: listedTools(terminalTools(db, 0)), projects };
  writeFileSync(join(userData, "terminal-tools.json"), `${JSON.stringify(catalog, null, 2)}\n`);
}

// A control socket connection that began "mcp {cwd}": answers "ready <workspace>" or "error: …", then one JSON-RPC
// message per line each way. The client sends nothing more until it has the answer.
export async function serveTerminal(
  db: Db,
  userData: string,
  socket: Socket,
  lines: Interface,
  hello: string,
) {
  let tools: McpTool[];
  try {
    const { cwd } = JSON.parse(hello) as { cwd?: unknown };
    if (typeof cwd !== "string") throw new Error('say where the session runs: mcp {"cwd": …}');
    const { workspaceId, label } = await terminalWorkspace(db, cwd);
    tools = terminalTools(db, workspaceId);
    await writeCatalog(db, userData).catch(() => {});
    socket.write(`ready ${label}\n`);
  } catch (e) {
    lines.close();
    return void socket.end(`error: ${(e as Error).message}\n`);
  }
  lines.on("line", async (line) => {
    let msg: McpMessage;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const reply = await answerMcp(tools, msg);
    if (reply && socket.writable) socket.write(`${JSON.stringify(reply)}\n`);
  });
  socket.on("end", () => socket.end());
}
