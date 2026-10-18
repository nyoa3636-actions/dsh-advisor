/**
 * Open the desktop Settings surface over CDP and inspect the Advisor section.
 * Usage: node scripts/verify-settings.mjs <webUrl> [cdpPort]
 */
const webUrl = process.argv[2];
const cdpPort = Number(process.argv[3] ?? 9222);
if (!webUrl) throw new Error("usage: node verify-settings.mjs <webUrl> [cdpPort]");

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

const click = (pattern, source = "aria") => evaluate(`(() => {
  const nodes = [...document.querySelectorAll('button, [role="button"], a, [aria-label], [role="menuitem"]')];
  const match = nodes.find((node) => {
    const label = (node.getAttribute('aria-label') || node.textContent || '').trim();
    return ${source === "aria" ? `/^${pattern}$/iu.test(label) || /^${pattern}\\b/iu.test(label)` : `/${pattern}/iu.test(label)`};
  });
  if (!match) return null;
  match.click();
  return (match.getAttribute('aria-label') || match.textContent || '').trim().slice(0, 60);
})()`);

// The desktop app puts Settings behind the account menu.
console.log("account menu:", await click("account menu", "loose"));
await sleep(1200);
const menu = await evaluate(`(() => [...document.querySelectorAll('[role="menuitem"], button, a')].map((n) => (n.textContent || n.getAttribute('aria-label') || '').trim()).filter(Boolean).slice(0, 40))()`);
console.log("menu items:", JSON.stringify(menu));

// The menu entry renders as "Settings" followed by its shortcut, so match a prefix.
const settingsClick = await evaluate(`(() => {
  const nodes = [...document.querySelectorAll('[role="menuitem"], button, a')];
  const match = nodes.find((node) => /^settings/iu.test((node.textContent || node.getAttribute('aria-label') || '').trim()));
  if (!match) return null;
  match.click();
  return (match.textContent || '').trim().slice(0, 40);
})()`);
console.log("settings click:", settingsClick);
await sleep(3000);

const nav = await evaluate(`(() => {
  const items = [...document.querySelectorAll('button, [role="tab"], a, li')]
    .map((node) => (node.textContent || '').trim())
    .filter((label) => label.length > 0 && label.length < 30);
  return [...new Set(items)];
})()`);
console.log("settings nav:", JSON.stringify(nav));

const advisorNav = await evaluate(`(() => {
  const nodes = [...document.querySelectorAll('button, [role="tab"], a, li')];
  const match = nodes.find((node) => /^(advisor|アドバイザー)$/iu.test((node.textContent || '').trim()));
  if (!match) return false;
  match.click();
  return true;
})()`);
console.log("advisor section clicked:", advisorNav);
await sleep(3000);

const page = await evaluate("document.body.innerText");
const signals = {
  advisorTabBudget: /(Budget|予算)/u.test(page),
  advisorTabHistory: /(History|履歴)/u.test(page),
  advisorTabTest: /(Connection test|接続テスト)/u.test(page),
  advisorModelField: /(Advisor model|Advisor モデル)/u.test(page),
  modelPickerOptions: await evaluate(`(() => {
    const select = [...document.querySelectorAll('select')].find((node) => [...node.options].some((option) => option.value.includes('/')));
    return select ? [...select.options].map((option) => option.value).filter(Boolean).slice(0, 8) : null;
  })()`),
  namespaceError: /does not expose the dsh-advisor settings namespace/u.test(page),
};
console.log("signals:", JSON.stringify(signals));
console.log("excerpt:", page.replace(/\n+/gu, " | ").slice(0, 900));
await send("Page.close").catch(() => {});
process.exit(0);
