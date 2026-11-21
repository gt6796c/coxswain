import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { agentPlace, sessionPlace } from "./agent-folder.ts";

async function checkout() {
  const root = realpathSync(await mkdtemp(join(tmpdir(), "coxswain-agent-folder-")));
  await mkdir(join(root, "backend"));
  await writeFile(join(root, "README.md"), "");
  return root;
}

test("the agent folder is a folder of the checkout, or else the checkout", async () => {
  const root = await checkout();
  try {
    const backend = agentPlace(root, "backend");
    assert.equal(backend.cwd, join(root, "backend"));
    assert.deepEqual(backend.additionalDirectories, [root]);
    assert.match(backend.note ?? "", /backend\/ folder/);
    assert.equal(agentPlace(root, "backend/").cwd, join(root, "backend"));
    assert.equal(agentPlace(root, " backend ").cwd, join(root, "backend"));
    for (const folder of [
      "",
      ".",
      "frontend",
      "README.md",
      "..",
      "../x",
      "/tmp",
      "backend/../..",
    ]) {
      assert.deepEqual(agentPlace(root, folder), { cwd: root }, folder);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("only the pane's sessions run in the agent folder", async () => {
  const root = await checkout();
  const before = process.env.COXSWAIN_AGENT_FOLDER;
  process.env.COXSWAIN_AGENT_FOLDER = "backend";
  try {
    const mcp = [{ name: "coxswain" }];
    const pane = sessionPlace({ cwd: root, mcp });
    assert.equal(pane.cwd, join(root, "backend"));
    assert.deepEqual(pane.additionalDirectories, [root]);
    assert.match(pane.note ?? "", /repository root is /);

    assert.deepEqual(sessionPlace({ cwd: root }), { cwd: root });
    assert.deepEqual(sessionPlace({ cwd: root, mcp: [] }), { cwd: root });

    delete process.env.COXSWAIN_AGENT_FOLDER;
    assert.deepEqual(sessionPlace({ cwd: root, mcp }), { cwd: root });
  } finally {
    if (before === undefined) delete process.env.COXSWAIN_AGENT_FOLDER;
    else process.env.COXSWAIN_AGENT_FOLDER = before;
    await rm(root, { recursive: true, force: true });
  }
});
