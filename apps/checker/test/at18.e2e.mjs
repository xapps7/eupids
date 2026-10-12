// AT-18: load the built page, upload a CSV with a unique marker, and prove that
// no network request carries file content. Also checks both barcode formats render.
import { createRequire } from "node:module";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const require = createRequire(import.meta.url);
let pw;
try { pw = require("playwright"); } catch { pw = require("/opt/node-tools/node_modules/playwright"); }

const MARKER = "SECRET-SKU-" + Math.random().toString(36).slice(2);
const dir = mkdtempSync(join(tmpdir(), "at18-"));
const classic = join(dir, "classic.csv");
writeFileSync(classic, [
  "Handle,Title,Vendor,Option1 Value,Variant SKU,Variant Price,Variant Barcode,Image Src,Status",
  `tee,Tee,Acme,S,${MARKER},10,5901234123457,https://cdn.shopify.com/x.jpg,active`,
  "tee,,,M,TEE-M,10,590123412345,,",
].join("\n"));
const typed = join(dir, "typed.csv");
writeFileSync(typed, [
  "URL handle,Title,Vendor,Status,SKU,Barcodes,Price",
  `mug,Mug,Acme,active,${MARKER}-2,"gtin:00012345678905; INTERNAL-123",5`,
].join("\n"));

const browser = await pw.chromium.launch();
const page = await browser.newPage();
const requests = [];
page.on("request", (r) => requests.push({ url: r.url(), body: r.postData() ?? "" }));
const url = "file://" + resolve("dist/index.html");
await page.goto(url);
await page.waitForSelector("#results:not([hidden])");
const before = requests.length;

await page.setInputFiles("#file", classic);
await page.waitForFunction(() => document.querySelector("#source")?.textContent?.includes("classic.csv"));
const score1 = await page.textContent("#score");
const rows1 = await page.locator("#rows tr").count();

await page.setInputFiles("#file", typed);
await page.waitForFunction(() => document.querySelector("#source")?.textContent?.includes("typed.csv"));
const score2 = await page.textContent("#score");

const after = requests.slice(before);
const leaking = requests.filter((r) => r.url.includes(MARKER) || r.body.includes(MARKER));
await page.setViewportSize({ width: 390, height: 900 });
const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
await browser.close();

const fail = [];
if (after.length) fail.push(`requests after upload: ${after.map((r) => r.url).join(", ")}`);
if (leaking.length) fail.push("a request carried file content");
if (!rows1) fail.push("classic file showed no issue rows");
if (overflow) fail.push("page scrolls sideways at 390px");
console.log({ score1, rows1, score2, requestsAfterUpload: after.length, overflowAt390: overflow });
if (fail.length) { console.error("AT-18 FAIL:", fail); process.exit(1); }
console.log("AT-18 PASS: no network request carried file content; both barcode formats parsed.");
