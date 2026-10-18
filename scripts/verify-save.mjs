/** Exercise Save through the real UI and report the written patch. */
const [webUrl, portArg] = process.argv.slice(2);
const cdpPort = Number(portArg ?? 9222);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const target = await (await fetch(`http://127.0.0.1:${cdpPort}/json/new?${encodeURIComponent(webUrl)}`, { method: "PUT" })).json();
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", () => reject(new Error("cdp socket failed")), { once: true });
});
let nextId = 1;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (!message.id || !pending.has(message.id)) return;
  const { resolve, reject } = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) reject(new Error(message.error.message));
  else resolve(message.result);
});
const send = (method, params = {}) => {
  const id = nextId++;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { reject, resolve }));
};
const evaluate = async (expression) => {
  const result = await send("Runtime.evaluate", { awaitPromise: true, expression, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? "evaluation failed");
  return result.result.value;
};

await send("Runtime.enable");
for (let attempt = 0; attempt < 60; attempt += 1) {
  await sleep(500);
  if (await evaluate("Boolean(document.querySelector('textarea, [contenteditable=\"true\"]'))")) break;
}
await evaluate(`(() => {
  const nodes = [...document.querySelectorAll('button, [role="button"], a, [role="menuitem"]')];
  const account = nodes.find((node) => /^account menu/iu.test((node.getAttribute('aria-label') || '').trim()));
  if (account) account.click();
})()`);
await sleep(1000);
await evaluate(`(() => {
  const nodes = [...document.querySelectorAll('[role="menuitem"], button, a')];
  const settings = nodes.find((node) => /^settings/iu.test((node.textContent || '').trim()));
  if (settings) settings.click();
})()`);
await sleep(2500);
await evaluate(`(() => {
  const nodes = [...document.querySelectorAll('button, [role="tab"], a, li')];
  const advisor = nodes.find((node) => /^(advisor|アドバイザー)$/iu.test((node.textContent || '').trim()));
  if (advisor) advisor.click();
})()`);
await sleep(2500);

const before = await evaluate(`(() => {
  const button = [...document.querySelectorAll('button[role="switch"]')][0];
  return button ? button.getAttribute('aria-checked') : null;
})()`);
console.log("first switch before:", before);

await evaluate(`(() => {
  const button = [...document.querySelectorAll('button[role="switch"]')][0];
  if (button) button.click();
})()`);
await sleep(600);
const after = await evaluate(`(() => {
  const button = [...document.querySelectorAll('button[role="switch"]')][0];
  return button ? button.getAttribute('aria-checked') : null;
})()`);
console.log("first switch after:", after);

const saved = await evaluate(`(() => {
  const buttons = [...document.querySelectorAll('button')];
  const save = buttons.find((node) => (node.textContent || '').trim() === 'Save' && !node.disabled);
  if (!save) return 'no enabled Save button';
  save.click();
  return 'clicked';
})()`);
console.log("save:", saved);
await sleep(2500);

const body = await evaluate("document.body.innerText");
const message = body.split("\n").find((line) => /saved|did not accept|error/i.test(line)) ?? "";
console.log("feedback:", JSON.stringify(message.trim().slice(0, 160)));
await send("Page.close").catch(() => {});
process.exit(0);
