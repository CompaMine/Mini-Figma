import { chromium } from "playwright-core";
import fs from "node:fs";

const chrome = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const url = process.env.FIG_URL || "http://127.0.0.1:4173";

const browser = await chromium.launch({
  executablePath: chrome,
  headless: true,
  args: [
    "--ignore-gpu-blocklist",
    "--enable-webgl",
    "--enable-gpu",
    "--use-gl=angle",
    "--hide-scrollbars",
  ],
});

const page = await browser.newPage({ viewport: { width: 1400, height: 860 } });
page.on("pageerror", (e) => console.error("PAGEERROR", e.message));
page.on("console", (m) => {
  if (m.type() === "error") console.error("CONSOLE", m.text());
});

await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
await page.waitForFunction(() => window.__fig, { timeout: 15000 });

const smoke = await page.evaluate(() => {
  const api = window.__fig;
  window.__figSilent = true;
  const g = api.generate(80, 42);
  const info = api.info();
  return { g, info, title: document.title };
});
console.log("SMOKE", JSON.stringify(smoke, null, 2));
if (!smoke.info.nodes) throw new Error("generate produced 0 nodes");

await page.evaluate(() => window.__fig.generate(2000, 42));
await page.waitForTimeout(200);
await page.screenshot({ path: "web/shot-wasm.png", fullPage: true });

const sizes = [1000, 10000, 100000];
const rows = [];

async function run(backend, n) {
  await page.evaluate(async (args) => {
    const api = window.__fig;
    window.__figSilent = true;
    if (api.info().backend !== args.backend) api.switchBackend(args.backend);
    api.generate(args.n, 7);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  }, { backend, n });
  await page.evaluate(() => window.__fig.bench());
  const last = await page.evaluate(() => {
    const rows = window.__fig.results();
    return rows[rows.length - 1];
  });
  console.log("BENCH", last.join(" | "));
  rows.push(last);
}

for (const n of sizes) {
  await run("wasm", n);
}
for (const n of [1000, 10000, 100000]) {
  await run("naive", n);
}

await page.screenshot({ path: "web/shot-naive.png" });

const bytes = await page.evaluate(() => {
  const api = window.__fig;
  api.switchBackend("wasm");
  api.generate(16, 1);
  return Array.from(new Uint8Array(
    // serialize from wasm through the same path the Save button uses
    (() => {
      const info = api.info();
      return info.nodes;
    })()
  ));
});

const ser = await page.evaluate(async () => {
  const a = document.querySelector("#btnSave");
  // peek format via __fig + core through generate/switch
  window.__fig.switchBackend("wasm");
  window.__fig.generate(4, 9);
  window.__fig.switchBackend("naive");
  const after = window.__fig.info();
  window.__fig.switchBackend("wasm");
  const back = window.__fig.info();
  return { naiveNodes: after.nodes, wasmNodes: back.nodes };
});
console.log("SERIALIZE_ROUNDTRIP", ser);

fs.writeFileSync("bench-results.json", JSON.stringify({ smoke, rows, ser }, null, 2));
await browser.close();
console.log("WROTE bench-results.json");
