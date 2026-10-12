// UC-06 (CSV round-trip), UC-13 (readiness report), FR-09, FR-13.
import type { PrismaClient } from "@prisma/client";
import { evaluate, parseCsv, toCsv, isValidGtin, normalizeBarcode } from "@pidready/rules";
import { snapshotToInput } from "./snapshot";
import { toRuleSettings } from "./evaluate.server";
import { fieldErrors, normalizeChange, type EditableField, type VariantChange } from "./validate";
import type { WriteItem } from "./writes.server";

export const ISSUE_COLUMNS = [
  "variant_id", "product_title", "variant_title", "vendor", "sku", "barcode", "ns_pid",
  "no_standard_identifier", "hs_code", "country_of_origin", "issues",
] as const;

const EDITABLE: Record<string, EditableField> = {
  sku: "sku",
  barcode: "barcode",
  ns_pid: "nspid",
  no_standard_identifier: "noStandardIdentifier",
  hs_code: "hsCode",
  country_of_origin: "countryOfOrigin",
};

export const DISCLAIMER_LINE = (d: Date) => `Data check generated ${d.toISOString().slice(0, 10)}. Not legal advice.`;

/** UC-06 step 1: variants with open issues (optionally filtered to a list). */
export async function exportIssuesCsv(db: PrismaClient, shopId: string, variantIds?: string[]) {
  const open = await db.issue.findMany({
    where: { shopId, status: "open", ...(variantIds ? { variantId: { in: variantIds } } : {}) },
    select: { variantId: true, ruleCode: true },
  });
  const codes = new Map<string, string[]>();
  for (const i of open) codes.set(i.variantId, [...(codes.get(i.variantId) ?? []), i.ruleCode]);
  const snaps = await db.variantSnapshot.findMany({
    where: { shopId, variantId: { in: [...codes.keys()] } },
    orderBy: [{ vendor: "asc" }, { productTitle: "asc" }, { variantTitle: "asc" }],
  });
  const rows: (string | boolean | null)[][] = [[...ISSUE_COLUMNS]];
  for (const s of snaps) {
    rows.push([
      s.variantId, s.productTitle, s.variantTitle, s.vendor, s.sku ?? "", s.barcodes[0] ?? "", s.nspid ?? "",
      s.noStandardIdentifier ? "true" : "false", s.hsCode ?? "", s.countryOfOrigin ?? "", (codes.get(s.variantId) ?? []).sort().join(" "),
    ]);
  }
  return toCsv(rows);
}

export type PreviewRow = {
  line: number;
  variantId: string;
  title: string;
  changes: VariantChange;
  errors: Partial<Record<EditableField, string>>;
  validChanges: VariantChange;
};

export type ImportPreview = {
  toChange: PreviewRow[];
  withErrors: PreviewRow[];
  unchanged: number;
  unknown: { line: number; variantId: string }[];
  headerError?: string;
};

const truthy = (v: string) => /^(true|yes|1|y)$/i.test(v.trim());

/** UC-06 step 3: parse, validate every row, and diff against snapshots. */
export async function previewImport(db: PrismaClient, shopId: string, text: string): Promise<ImportPreview> {
  const rows = parseCsv(text);
  const out: ImportPreview = { toChange: [], withErrors: [], unchanged: 0, unknown: [] };
  if (!rows.length) return { ...out, headerError: "The file is empty." };
  const header = rows[0]!.map((h) => h.trim().toLowerCase());
  const idx = (c: string) => header.indexOf(c);
  if (idx("variant_id") === -1) return { ...out, headerError: "The file needs a variant_id column. Export the issues CSV and edit that file." };

  const settings = await db.settings.findUnique({ where: { shopId } });
  const ids = rows.slice(1).map((r) => (r[idx("variant_id")] ?? "").trim()).filter(Boolean);
  const snaps = await db.variantSnapshot.findMany({ where: { shopId, variantId: { in: ids } } });
  const by = new Map(snaps.map((s) => [s.variantId, s]));

  rows.slice(1).forEach((r, n) => {
    const line = n + 2;
    const variantId = (r[idx("variant_id")] ?? "").trim();
    if (!variantId) return;
    const snap = by.get(variantId);
    if (!snap) {
      out.unknown.push({ line, variantId }); // A1
      return;
    }
    const raw: VariantChange = {};
    for (const [col, field] of Object.entries(EDITABLE)) {
      const i = idx(col);
      if (i === -1) continue;
      const cell = r[i] ?? "";
      if (field === "noStandardIdentifier") (raw as any)[field] = truthy(cell);
      else (raw as any)[field] = cell;
    }
    const norm = normalizeChange(raw);
    const current: Record<EditableField, unknown> = {
      sku: snap.sku || null,
      barcode: snap.barcodes[0] ? normalizeBarcode(snap.barcodes[0]) : null,
      nspid: snap.nspid || null,
      noStandardIdentifier: snap.noStandardIdentifier,
      hsCode: snap.hsCode || null,
      countryOfOrigin: snap.countryOfOrigin || null,
    };
    const changes: VariantChange = {};
    for (const f of Object.keys(norm) as EditableField[]) {
      if ((norm as any)[f] !== current[f]) (changes as any)[f] = (norm as any)[f];
    }
    if (!Object.keys(changes).length) {
      out.unchanged++;
      return;
    }
    const errors = fieldErrors(changes, settings?.extraPlaceholders ?? []);
    const validChanges: VariantChange = {};
    for (const f of Object.keys(changes) as EditableField[]) if (!errors[f]) (validChanges as any)[f] = (changes as any)[f];
    const title = [snap.productTitle, snap.variantTitle].filter(Boolean).join(" / ");
    const row: PreviewRow = { line, variantId, title, changes, errors, validChanges };
    if (Object.keys(errors).length) out.withErrors.push(row);
    else out.toChange.push(row);
  });
  return out;
}

/** UC-06 A2: build job items, either applying valid fields of failing rows, or skipping them. */
export function itemsFromPreview(p: ImportPreview, mode: "valid_fields" | "skip_rows"): WriteItem[] {
  const items: WriteItem[] = p.toChange.map((r) => ({ variantId: r.variantId, changes: r.changes }));
  if (mode === "valid_fields") {
    for (const r of p.withErrors) if (Object.keys(r.validChanges).length) items.push({ variantId: r.variantId, changes: r.validChanges });
  }
  return items;
}

/** UC-06: downloadable CSV of failures (validation errors + write failures). */
export function failuresCsv(
  preview: { withErrors: PreviewRow[]; unknown: { line: number; variantId: string }[] } | null,
  writeFailures: { variantId: string; status: string; errors: Record<string, string> }[],
) {
  const rows: string[][] = [["variant_id", "line", "stage", "problem"]];
  for (const u of preview?.unknown ?? []) rows.push([u.variantId, String(u.line), "preview", "Unknown variant_id. This variant is not in your store."]);
  for (const r of preview?.withErrors ?? []) rows.push([r.variantId, String(r.line), "preview", Object.entries(r.errors).map(([f, m]) => `${f}: ${m}`).join(" | ")]);
  for (const f of writeFailures) rows.push([f.variantId, "", f.status, Object.entries(f.errors).map(([k, m]) => `${k}: ${m}`).join(" | ")]);
  return toCsv(rows);
}

/** UC-13 / FR-13: one row per in-scope variant, values from the latest scan. */
export async function readinessReportCsv(db: PrismaClient, shopId: string, now = new Date()) {
  const [snaps, settings] = await Promise.all([
    db.variantSnapshot.findMany({ where: { shopId }, orderBy: [{ vendor: "asc" }, { productTitle: "asc" }, { variantTitle: "asc" }] }),
    db.settings.findUnique({ where: { shopId } }),
  ]);
  const r = evaluate(snaps.map(snapshotToInput), toRuleSettings(settings));
  const byId = new Map(r.results.map((x) => [x.variantId, x]));
  const rows: string[][] = [
    [DISCLAIMER_LINE(now)],
    ["variant_id", "product_title", "variant_title", "sku", "ns_pid", "s_pid", "s_pid_exception", "hs_code", "country_of_origin", "status"],
  ];
  for (const s of snaps) {
    const res = byId.get(s.variantId);
    if (!res?.inScope) continue;
    rows.push([
      s.variantId, s.productTitle, s.variantTitle, s.sku ?? "", s.nspid ?? "",
      res.spid ?? (s.barcodes[0] && isValidGtin(normalizeBarcode(s.barcodes[0])) ? normalizeBarcode(s.barcodes[0]) : ""),
      res.spidException ?? "", s.hsCode ?? "", s.countryOfOrigin ?? "", res.ready ? "ready" : "not_ready",
    ]);
  }
  return toCsv(rows);
}

export type CustomsFormat = "standard" | "shipping_app";

/**
 * The file a carrier, broker or shipping app needs: one row per variant with the three
 * identifiers as they go on the EU customs declaration (document codes C127 / C128 / C129,
 * exception Y081), plus HS code and origin. `only` limits it to EU-shipped variants.
 */
export async function customsFileCsv(db: PrismaClient, shopId: string, opts: { format: CustomsFormat; only?: Set<string> | null }, now = new Date()) {
  const [snaps, settings, demand] = await Promise.all([
    db.variantSnapshot.findMany({ where: { shopId }, orderBy: [{ vendor: "asc" }, { productTitle: "asc" }, { variantTitle: "asc" }] }),
    db.settings.findUnique({ where: { shopId } }),
    db.euDemand.findMany({ where: { shopId }, select: { variantId: true, units: true } }),
  ]);
  const units = new Map(demand.map((d) => [d.variantId, d.units]));
  const r = evaluate(snaps.map(snapshotToInput), toRuleSettings(settings));
  const byId = new Map(r.results.map((x) => [x.variantId, x]));
  const rows: (string | number)[][] =
    opts.format === "shipping_app"
      ? [["sku", "product_title", "variant_title", "m_pid", "ns_pid", "s_pid", "s_pid_exception", "hs_code", "country_of_origin", "ready"]]
      : [
          [DISCLAIMER_LINE(now)],
          [
            "Product", "Variant", "SKU (M-PID, code C127)", "Manufacturer code (NS-PID, code C128)", "Barcode (S-PID, code C129)",
            "No barcode (exception Y081)", "HS code", "Country of origin", "Units shipped to EU (60 days)", "Ready",
          ],
        ];
  for (const s of snaps) {
    const res = byId.get(s.variantId);
    if (!res?.inScope) continue;
    if (opts.only && !opts.only.has(s.variantId)) continue;
    const spid = res.spid ?? "";
    const exc = res.spidException ?? "";
    const ready = res.ready ? "yes" : "no";
    if (opts.format === "shipping_app") {
      rows.push([s.sku ?? "", s.productTitle, s.variantTitle, s.sku ?? "", s.nspid ?? "", spid, exc, s.hsCode ?? "", s.countryOfOrigin ?? "", ready]);
    } else {
      rows.push([s.productTitle, s.variantTitle, s.sku ?? "", s.nspid ?? "", spid, exc, s.hsCode ?? "", s.countryOfOrigin ?? "", units.get(s.variantId) ?? 0, ready]);
    }
  }
  return toCsv(rows);
}
