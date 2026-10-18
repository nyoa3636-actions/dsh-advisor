/**
 * Screenshot the Advisor Settings section in a real Chromium page.
 * Usage: node scripts/shot-advisor.mjs <webUrl> <outPath> [cdpPort]
 */
const [webUrl, outPath, portArg] = process.argv.slice(2);
const cdpPort = Number(portArg ?? 9222);
if (!webUrl || !outPath) throw new Error("usage: node shot-advisor.mjs <webUrl> <outPath> [cdpPort]");

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
await send("Emulation.setDeviceMetricsOverride", { deviceScaleFactor: 1, height: 900, mobile: false, width: 1440 });
for (let attempt = 0; attempt < 60; attempt += 1) {
  await sleep(500);
  if (await evaluate("Boolean(document.querySelector('textarea, [contenteditable=\"true\"]'))")) break;
}

const clickByText = (pattern) => evaluate(`(() => {
  const nodes = [...document.querySelectorAll('button, [role="button"], a, [role="menuitem"]')];
  const match = nodes.find((node) => ${pattern}.test((node.getAttribute('aria-label') || node.textContent || '').trim()));
  if (!match) return null;
  match.click();
  return (match.textContent || match.getAttribute('aria-label') || '').trim().slice(0, 40);
})()`);

await clickByText("/^account menu/iu");
await sleep(1000);
await evaluate(`(() => {
  const nodes = [...document.querySelectorAll('[role="menuitem"], button, a')];
  const match = nodes.find((node) => /^settings/iu.test((node.textContent || '').trim()));
  if (match) match.click();
})()`);
await sleep(2500);
await evaluate(`(() => {
  const nodes = [...document.querySelectorAll('button, [role="tab"], a, li')];
  const match = nodes.find((node) => /^(advisor|アドバイザー)$/iu.test((node.textContent || '').trim()));
  if (match) match.click();
})()`);
await sleep(3000);

const shot = await send("Page.captureScreenshot", { format: "png" });
const { writeFile } = await import("node:fs/promises");
await writeFile(outPath, Buffer.from(shot.data, "base64"));
console.log("screenshot written:", outPath);

const details = await evaluate(`(() => {
  const selects = [...document.querySelectorAll('select')].map((node) => ({
    label: node.getAttribute('aria-label') || '',
    options: [...node.options].map((option) => ({ text: option.textContent.trim(), value: option.value })).slice(0, 12),
  }));
  return { selects, text: document.body.innerText.slice(0, 1200) };
})()`);
console.log("selects:", JSON.stringify(details.selects));
await send("Page.close").catch(() => {});
process.exit(0);
