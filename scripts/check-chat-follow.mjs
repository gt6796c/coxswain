// Run against a development app started with REMOTE_DEBUGGING_PORT=9222 pnpm dev, with a workspace and its agent pane
// open. Appends synthetic content to the chat transcript (removed afterwards); never sends an agent message.
import assert from "node:assert/strict";

const pages = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const page = pages.find(
  (candidate) => candidate.type === "page" && candidate.url.startsWith("http://localhost:"),
);
assert.ok(page, "Start the development app with REMOTE_DEBUGGING_PORT=9222");
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});
try {
  const response = new Promise((resolve, reject) => {
    socket.addEventListener("message", ({ data }) => {
      const message = JSON.parse(data);
      if (message.id === 1) resolve(message.result);
    });
    socket.addEventListener("error", reject, { once: true });
  });
  socket.send(
    JSON.stringify({
      id: 1,
      method: "Runtime.evaluate",
      params: {
        expression: `(${checkChatFollow.toString()})()`,
        awaitPromise: true,
        returnByValue: true,
      },
    }),
  );
  const result = await response;
  assert.ok(!result.exceptionDetails, result.exceptionDetails?.exception?.description);
  const rows = result.result.value;
  for (const row of rows) console.log(row);
  for (const row of rows) assert.ok(row.ok, row.step);
} finally {
  socket.close();
}

async function checkChatFollow() {
  const frames = (n) =>
    new Promise((resolve) => {
      const step = () => (n-- <= 0 ? resolve() : requestAnimationFrame(step));
      requestAnimationFrame(step);
    });
  const transcript = [...document.querySelectorAll('div[tabindex="-1"]')].find(
    (el) => el.style.overflowAnchor === "none" && el.classList.contains("overflow-y-auto"),
  );
  if (!transcript) throw new Error("Open a workspace with its agent pane shown");
  const content = transcript.firstElementChild;
  const latest = () => transcript.parentElement.querySelector('button[title="Jump to Latest"]');
  const gap = () => transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight;
  const added = [];
  const add = (lines) => {
    const block = document.createElement("div");
    block.textContent = "synthetic chat line ".repeat(lines * 8);
    content.append(block);
    added.push(block);
  };
  const rows = [];
  try {
    // Enough content to scroll, then the end.
    add(200);
    await frames(3);
    transcript.scrollTop = transcript.scrollHeight;
    await frames(3);
    rows.push({ step: "starts at the end, no Latest", ok: gap() <= 24 && !latest(), gap: gap() });

    // Streaming at the end: several growths in a row, each landing before the last scroll event.
    for (let i = 0; i < 5; i++) {
      add(10);
      await frames(1);
    }
    await frames(3);
    rows.push({
      step: "follows streamed content at the end",
      ok: gap() <= 24 && !latest(),
      gap: gap(),
    });

    // The reader scrolls up: new content leaves them in place and Latest shows.
    transcript.scrollTop = transcript.scrollTop - 400;
    await frames(3);
    const before = transcript.scrollTop;
    add(10);
    await frames(3);
    rows.push({
      step: "scrolled up stays put and shows Latest",
      ok: transcript.scrollTop === before && !!latest(),
      moved: transcript.scrollTop - before,
    });

    // Latest jumps to the end and follows again.
    latest().click();
    await frames(3);
    add(10);
    await frames(3);
    rows.push({
      step: "Latest jumps to the end and follows again",
      ok: gap() <= 24 && !latest(),
      gap: gap(),
    });
  } finally {
    added.forEach((block) => block.remove());
  }
  return rows;
}
