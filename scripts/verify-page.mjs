/**
 * Verify the Advisor section in a real Chromium page over CDP.
 * Usage: node scripts/verify-page.mjs <webUrl> [cdpPort]
 */
const webUrl = process.argv[2];
const cdpPort = Number(process.argv[3] ?? 9222);
if (!webUrl) throw new Error("usage: node verify-page.mjs <webUrl> [cdpPort]");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function newTarget(url) {
  const response = await fetch(`http://127.0.0.1:${cdpPort}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  if (!response.ok) throw new Error(`cannot open target: ${response.status}`);
  return response.json();
}

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      }
    });
  }

  static async connect(wsUrl) {
    const socket = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", () => reject(new Error("cdp socket failed")), { once: true });
    });
    return new Cdp(socket);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { reject, resolve }));
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      awaitPromise: true,
      expression,
      returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? "evaluation failed");
    return result.result.value;
  }
}

const target = await newTarget(webUrl);
const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
await cdp.send("Runtime.enable");
await cdp.send("Page.enable");

// Wait for the Harness application shell to settle.
let ready = false;
for (let attempt = 0; attempt < 60; attempt += 1) {
  await sleep(500);
  try {
    ready = await cdp.evaluate("Boolean(document.querySelector('[class*=\"composer\"], textarea, [contenteditable=\"true\"]'))");
  } catch {
    ready = false;
  }
  if (ready) break;
}

const text = await cdp.evaluate("document.body.innerText");
const bootFailure = /did not activate|cannot get property .* without inject|is waiting for activation/u.test(text);
console.log("shell ready:", ready);
console.log("boot failure text:", bootFailure);
if (bootFailure) console.log("body excerpt:", text.slice(0, 400).replace(/\n+/gu, " | "));

// Expand the sidebar first so the Settings trigger is reachable.
const expanded = await cdp.evaluate(`(() => {
  const nodes = [...document.querySelectorAll('button, [role="button"]')];
  const trigger = nodes.find((node) => /open sidebar/iu.test(node.getAttribute('aria-label') || ''));
  if (!trigger) return false;
  trigger.click();
  return true;
})()`);
console.log("sidebar expanded:", expanded);
await sleep(1200);

// The Plugins page reports a failing plugin inline, which is a direct signal.
const pluginsOpened = await cdp.evaluate(`(() => {
  const nodes = [...document.querySelectorAll('button, [role="button"], a')];
  const trigger = nodes.find((node) => /^plugins$/iu.test(((node.getAttribute('aria-label') || node.textContent || '')).trim()));
  if (!trigger) return false;
  trigger.click();
  return true;
})()`);
await sleep(2500);
if (pluginsOpened) {
  const pluginsText = await cdp.evaluate("document.body.innerText");
  const advisorLine = pluginsText.split("\n").find((line) => /dsh-advisor/iu.test(line)) ?? "";
  const errorLine = pluginsText.split("\n").find((line) => /Error:/u.test(line)) ?? "";
  console.log("plugins page opened:", pluginsOpened);
  console.log("advisor row:", JSON.stringify(advisorLine.trim()));
  console.log("plugin error line:", JSON.stringify(errorLine.trim()));
}

// Open Settings through its accessible trigger, then list the navigation.
const candidates = await cdp.evaluate(`(() => {
  const nodes = [...document.querySelectorAll('button, [role="button"], a, [aria-label]')];
  return [...new Set(nodes.map((node) => ((node.getAttribute('aria-label') || '') + '|' + (node.textContent || '')).trim()).filter(Boolean))].slice(0, 60);
})()`);
console.log("clickable labels:", JSON.stringify(candidates));

const opened = await cdp.evaluate(`(() => {
  const nodes = [...document.querySelectorAll('button, [role="button"], a, [aria-label]')];
  const trigger = nodes.find((node) => /^(settings|設定)$/iu.test(((node.getAttribute('aria-label') || node.textContent || '')).trim()))
    ?? nodes.find((node) => /(^|\s)(settings|設定)(\s|$)/iu.test((node.getAttribute('aria-label') || node.textContent || '')));
  if (!trigger) return false;
  trigger.click();
  return true;
})()`);
console.log("settings trigger clicked:", opened);
await sleep(2000);

const nav = await cdp.evaluate(`(() => {
  const rows = [...document.querySelectorAll('button, [role="tab"], a')]
    .map((node) => (node.textContent || '').trim())
    .filter((label) => label.length > 0 && label.length < 40);
  return [...new Set(rows)];
})()`);
console.log("settings navigation:", JSON.stringify(nav));

const hasAdvisor = Array.isArray(nav) && nav.some((label) => /^(Advisor|アドバイザー)$/u.test(label));
console.log("Advisor navigation present:", hasAdvisor);

if (hasAdvisor) {
  await cdp.evaluate(`(() => {
    const node = [...document.querySelectorAll('button, [role="tab"], a')]
      .find((candidate) => /^(Advisor|アドバイザー)$/u.test((candidate.textContent || '').trim()));
    if (node) node.click();
  })()`);
  await sleep(2000);
  const page = await cdp.evaluate("document.body.innerText");
  const signals = {
    budgetTab: /(Budget|予算)/u.test(page),
    historyTab: /(History|履歴)/u.test(page),
    testTab: /(Connection test|接続テスト)/u.test(page),
    modelField: /(Advisor model|Advisor モデル)/u.test(page),
    settingsError: /does not expose the dsh-advisor|Advisor Settings payload/u.test(page),
  };
  console.log("page signals:", JSON.stringify(signals));
  console.log("page excerpt:", page.slice(0, 500).replace(/\n+/gu, " | "));
}

await cdp.send("Page.close").catch(() => {});
process.exit(0);
