// UC-17 free web checker. Everything runs in this page; the file is never sent anywhere (AT-18).
import { evaluate, DISCLAIMER, parseCsv, summarize, daysUntilEnforcement, type RuleCode } from "@pidready/rules";
import { detectColumns, missingRequired, toVariants, type ColumnMap, type Field } from "./shopifyCsv.js";
import { sampleCsv } from "./sample.js";

declare const __INSTALL_URL__: string;
const INSTALL_URL = typeof __INSTALL_URL__ === "string" ? __INSTALL_URL__ : "#";
const PREVIEW_ROWS = 25;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const fmt = (n: number) => n.toLocaleString("en-US");

function renderCountdown() {
  const d = daysUntilEnforcement();
  $("countdown").textContent = d === null ? "Now enforced" : `${d} day${d === 1 ? "" : "s"} to 1 Nov 2026`;
}

// ---------- file intake ----------

function readFile(file: File) {
  if (!/\.csv$/i.test(file.name) && file.type !== "text/csv") {
    showError("That doesn’t look like a CSV file. Export your products from Shopify as CSV and drop it here.");
    return;
  }
  const reader = new FileReader();
  reader.onload = () => run(String(reader.result ?? ""), file.name, false);
  reader.onerror = () => showError("We couldn’t read that file. Try exporting it again.");
  reader.readAsText(file);
}

function showError(msg: string) {
  const el = $("error");
  el.textContent = msg;
  el.hidden = false;
}

let pending: { rows: string[][]; name: string } | null = null;

function run(text: string, name: string, isSample: boolean) {
  runRows(parseCsv(text), name, isSample);
}

function runRows(rows: string[][], name: string, isSample: boolean, forced?: ColumnMap) {
  $("error").hidden = true;
  if (rows.length < 2) return showError("This file has no product rows.");
  const headers = rows[0]!;
  const detected = detectColumns(headers);
  const map = forced ?? detected.map;
  const missing = missingRequired(map);
  if (missing.length) {
    pending = { rows, name };
    return showMapping(headers, map, missing);
  }
  $("mapping").hidden = true;

  const cat = toVariants(rows, map);
  const skipRules: RuleCode[] = [];
  if (!cat.has.hsCode) skipRules.push("R-HS-01", "R-HS-02");
  if (!cat.has.countryOfOrigin) skipRules.push("R-COO-01");
  const result = evaluate(cat.variants, { skipRules });
  const vendorOf = (id: string) => cat.display.get(id)?.vendor ?? "";
  const s = summarize(result, vendorOf);

  // --- header of results
  $("source").innerHTML = isSample
    ? `<span class="tag">Example data</span> A sample home-textiles store. Drop your own export to check yours.`
    : `<span class="tag tag-file">Your file</span> ${esc(name)} · ${fmt(cat.products)} products · ${fmt(cat.variants.length)} variants`;

  // --- score
  const score = s.score;
  $("score").textContent = score === null ? "—" : `${score}%`;
  $("score-bar").style.setProperty("--pct", `${score ?? 0}%`);
  $("score-bar").dataset.band = score === null ? "none" : score >= 90 ? "good" : score >= 50 ? "mid" : "low";
  $("score-note").textContent =
    s.inScope === 0
      ? "Nothing to check. Only active products that ship count, and gift cards are skipped."
      : `${fmt(s.ready)} of ${fmt(s.inScope)} variants are ready.` +
        (s.outOfScope ? ` ${fmt(s.outOfScope)} skipped (draft, gift card or not shipped).` : "");

  // --- three identifiers
  const idBox = (el: string, c: { missing: number; invalid: number; ok: number }) => {
    const box = $(el);
    box.querySelector(".n-missing")!.textContent = fmt(c.missing);
    box.querySelector(".n-invalid")!.textContent = fmt(c.invalid);
    box.querySelector(".n-ok")!.textContent = fmt(c.ok);
    const total = Math.max(1, c.missing + c.invalid + c.ok);
    (box.querySelector(".stack") as HTMLElement).style.gridTemplateColumns =
      `${c.ok / total}fr ${c.invalid / total}fr ${c.missing / total}fr`;
  };
  idBox("id-mpid", s.mpid);
  idBox("id-nspid", s.nspid);
  idBox("id-spid", s.spid);

  // --- notices
  const notes: string[] = [];
  if (!cat.has.nspid)
    notes.push(
      "<strong>No manufacturer code column in this file.</strong> Shopify has no built-in field for it, so every variant shows as missing. This is the gap most stores have.",
    );
  if (!cat.has.hsCode || !cat.has.countryOfOrigin)
    notes.push("HS code and country of origin aren’t in Shopify’s product export, so we didn’t check them here. The app checks them.");
  notes.push("Barcode “none” confirmations (exception Y081) live in a variant field the export leaves out. The app reads them.");
  $("notes").innerHTML = notes.map((n) => `<li>${n}</li>`).join("");

  // --- vendors
  $("vendors").innerHTML = s.topVendorsMissingNspid.length
    ? s.topVendorsMissingNspid
        .map((v) => `<li><span>${esc(v.vendor)}</span><span class="num">${fmt(v.count)}</span></li>`)
        .join("")
    : `<li class="muted">Every vendor has manufacturer codes.</li>`;

  // --- rules
  $("rules").innerHTML = s.byRule.length
    ? s.byRule
        .map(
          (r) =>
            `<li><span class="sev sev-${r.severity}">${r.severity}</span><span class="rule-msg">${esc(r.message)}</span><span class="num">${fmt(r.variants)}</span></li>`,
        )
        .join("")
    : `<li class="muted">No issues found.</li>`;

  // --- sample rows
  const byVariant = new Map<string, typeof result.issues>();
  for (const i of result.issues) {
    const arr = byVariant.get(i.variantId) ?? [];
    arr.push(i);
    byVariant.set(i.variantId, arr);
  }
  const flagged = [...byVariant.keys()];
  const shown = flagged.slice(0, PREVIEW_ROWS);
  $("table-caption").textContent =
    flagged.length > PREVIEW_ROWS
      ? `First ${PREVIEW_ROWS} of ${fmt(flagged.length)} variants with issues`
      : `${fmt(flagged.length)} variant${flagged.length === 1 ? "" : "s"} with issues`;
  const cell = (v: string) => (v ? `<code>${esc(v)}</code>` : `<span class="blank">empty</span>`);
  $("rows").innerHTML = shown
    .map((id) => {
      const d = cat.display.get(id)!;
      const chips = byVariant
        .get(id)!
        .map((i) => `<span class="chip chip-${i.severity}" title="${esc(i.code)}">${esc(i.message)}${i.suggestion ? ` Try <code>${esc(i.suggestion)}</code>.` : ""}</span>`)
        .join("");
      return `<tr>
        <td><div class="p-title">${esc(d.productTitle)}</div><div class="p-sub">${esc(d.variantTitle || "—")} · ${esc(d.vendor || "no vendor")}</div></td>
        <td>${cell(d.sku)}</td><td>${cell(d.nspid)}</td><td>${cell(d.barcode)}</td>
        <td class="chips"><div>${chips}</div></td></tr>`;
    })
    .join("");

  // --- CTA
  const fixable = result.issues.length;
  $("cta-title").textContent =
    fixable === 0 ? "Keep it that way" : `Install to fix all ${fmt(fixable)} issue${fixable === 1 ? "" : "s"}`;
  $("cta-body").textContent =
    fixable === 0
      ? "PID Ready re-checks every new and edited product, so new gaps don’t reach customs."
      : "Fix rows inline or by CSV, send your suppliers one link to fill in their codes, and re-check every new product automatically.";

  $("results").hidden = false;
  if (!isSample) $("results").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
}

// ---------- E-15 column mapping ----------

const FIELD_LABEL: Partial<Record<Field, string>> = {
  handle: "Product handle",
  sku: "SKU",
  barcode: "Barcode",
};

function showMapping(headers: string[], map: ColumnMap, missing: Field[]) {
  const box = $("mapping");
  const opts = headers.map((h, i) => `<option value="${i}">${esc(h || `Column ${i + 1}`)}</option>`).join("");
  $("mapping-fields").innerHTML = missing
    .map(
      (f) => `<label class="map-row" for="map-${f}"><span>${FIELD_LABEL[f] ?? f}</span>
        <select id="map-${f}" data-field="${f}"><option value="">Choose a column…</option>${opts}</select></label>`,
    )
    .join("");
  box.hidden = false;
  box.dataset.map = JSON.stringify(map);
  box.scrollIntoView({ block: "center" });
}

function applyMapping() {
  if (!pending) return;
  const map: ColumnMap = JSON.parse($("mapping").dataset.map ?? "{}");
  for (const sel of document.querySelectorAll<HTMLSelectElement>("#mapping-fields select")) {
    if (sel.value !== "") map[sel.dataset.field as Field] = Number(sel.value);
  }
  const still = missingRequired(map);
  if (still.length) return showError(`Pick a column for: ${still.map((f) => FIELD_LABEL[f] ?? f).join(", ")}.`);
  const text = pending;
  pending = null;
  runRows(text.rows, text.name, false, map);
}

// ---------- boot ----------

function boot() {
  renderCountdown();
  $("disclaimer").textContent = DISCLAIMER;
  const cta = $("cta-link") as HTMLAnchorElement;
  cta.href = INSTALL_URL;

  const input = $<HTMLInputElement>("file");
  input.addEventListener("change", () => input.files?.[0] && readFile(input.files[0]));
  const zone = $("drop");
  zone.addEventListener("dragover", (e) => {
    e.preventDefault();
    zone.classList.add("over");
  });
  zone.addEventListener("dragleave", () => zone.classList.remove("over"));
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.classList.remove("over");
    const f = e.dataTransfer?.files?.[0];
    if (f) readFile(f);
  });
  $("sample").addEventListener("click", () => run(sampleCsv(), "sample.csv", true));
  $("map-apply").addEventListener("click", applyMapping);

  run(sampleCsv(), "sample.csv", true);
}

boot();
