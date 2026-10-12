// UC-04 / FR-06 / FR-07 / FR-15: write identifier changes to Shopify.
//  - SKU, barcode      → productVariantsBulkUpdate (per product, all changed variants)
//  - NS-PID, no-barcode → metafieldsSet (25 per call)
//  - HS code, origin   → inventoryItemUpdate (1 per item)
// Before writing, every variant is re-read and its updatedAt compared (optimistic concurrency).
// Only changed fields are written. Every write is audit-logged with old → new values.
import type { PrismaClient } from "@prisma/client";
import type { Gql } from "./gql.server";
import {
  INVENTORY_ITEM_UPDATE,
  METAFIELDS_DELETE,
  METAFIELDS_SET,
  VARIANTS_BULK_UPDATE,
  nodesQuery,
  type NspidKey,
} from "./queries";
import { isValidGtin, normalizeBarcode } from "@pidready/rules";
import { barcodeList, nodeToSnapshot, splitBarcodes, type BarcodeEntry, type VariantNode } from "./snapshot";
import { NOSTD } from "./metafields.server";
import { normalizeChange, type EditableField, type VariantChange } from "./validate";
import { reevaluateShop } from "./evaluate.server";
import { upsertSnapshots } from "./snapshot-store.server";

export type WriteItem = {
  variantId: string;
  changes: VariantChange;
  /** The updatedAt the merchant saw. Defaults to the stored snapshot's updatedAt. */
  expectedUpdatedAt?: Date | string | null;
};

export type WriteOutcome = {
  variantId: string;
  status: "saved" | "unchanged" | "conflict" | "missing" | "error";
  written: EditableField[];
  errors: Partial<Record<EditableField | "general", string>>;
};

export type WriteCtx = { shopId: string; actor: string; auditAction?: string };

const chunk = <T,>(arr: T[], n: number) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

export async function nspidKey(db: PrismaClient, shopId: string): Promise<NspidKey & { mappingRequired: boolean }> {
  const s = await db.settings.findUnique({ where: { shopId } });
  return { namespace: s?.nspidNamespace ?? "customs", key: s?.nspidKey ?? "manufacturer_product_id", mappingRequired: !!s?.mappingRequired };
}

async function fetchNodes(gql: Gql, k: NspidKey, ids: string[]) {
  const out = new Map<string, VariantNode>();
  for (const c of chunk(ids, 100)) {
    const data = await gql<{ nodes: (VariantNode | null)[] }>(nodesQuery(k), { ids: c });
    for (const n of data.nodes) if (n?.id) out.set(n.id, n);
  }
  return out;
}

function currentValues(n: VariantNode) {
  const split = splitBarcodes(barcodeList(n), n.nspid?.value?.trim() || null);
  return {
    sku: n.sku || null,
    barcode: split.standard[0] || null,
    nspid: n.nspid?.value || null,
    noStandardIdentifier: n.noStd?.value === "true",
    hsCode: n.inventoryItem?.harmonizedSystemCode || null,
    countryOfOrigin: n.inventoryItem?.countryCodeOfOrigin || null,
  };
}

/** Does this Shopify answer carry the 2026-10 barcode list? Then we write the whole list. */
const hasBarcodeList = (n: VariantNode) => !!n.barcodes && Array.isArray(n.barcodes.nodes);

/**
 * Build the full barcode list to send (`barcodes` replaces the whole set). Keeps every other
 * entry in place and in order:
 *  - barcode change: replace the entry that counts as the standard barcode, or put the new one first
 *  - manufacturer code change: if the old code is in the list, swap it for the new one
 */
export function nextBarcodes(n: VariantNode, diff: VariantChange): BarcodeEntry[] | null {
  const list = barcodeList(n).map((b) => ({ value: b.value, type: b.type ?? null }));
  const oldNspid = n.nspid?.value?.trim() || null;
  let changed = false;
  if ("barcode" in diff) {
    const std = splitBarcodes(list, oldNspid).standard[0];
    const idx = std ? list.findIndex((b) => b.value.trim() === std) : -1;
    const nv = diff.barcode ? normalizeBarcode(diff.barcode) : "";
    const entry = { value: nv, type: nv && isValidGtin(nv) ? "GTIN" : null };
    if (nv) {
      if (idx >= 0) list[idx] = entry;
      else list.unshift(entry);
    } else if (idx >= 0) list.splice(idx, 1);
    changed = true;
  }
  if ("nspid" in diff && oldNspid) {
    const idx = list.findIndex((b) => !b.type && b.value.trim() === oldNspid);
    if (idx >= 0) {
      if (diff.nspid) list[idx] = { value: diff.nspid, type: null };
      else list.splice(idx, 1);
      changed = true;
    }
  }
  return changed ? list : null;
}

export async function applyChanges(
  db: PrismaClient,
  gql: Gql,
  ctx: WriteCtx,
  items: WriteItem[],
  opts: { reevaluate?: boolean; audit?: "per-field" | "none" } = {},
): Promise<WriteOutcome[]> {
  const k = await nspidKey(db, ctx.shopId);
  const outcomes = new Map<string, WriteOutcome>();
  for (const it of items) outcomes.set(it.variantId, { variantId: it.variantId, status: "unchanged", written: [], errors: {} });

  if (k.mappingRequired) {
    // E-09: the default key exists with another type; the merchant must map first (UC-11).
    for (const o of outcomes.values()) {
      o.status = "error";
      o.errors.general = "Choose which field holds manufacturer codes in Settings before saving.";
    }
    return [...outcomes.values()];
  }

  const snaps = await db.variantSnapshot.findMany({ where: { shopId: ctx.shopId, variantId: { in: items.map((i) => i.variantId) } } });
  const snapBy = new Map(snaps.map((s) => [s.variantId, s]));
  const live = await fetchNodes(gql, k, items.map((i) => i.variantId));

  type Plan = { item: WriteItem; node: VariantNode; diff: VariantChange; old: ReturnType<typeof currentValues> };
  const plans: Plan[] = [];
  for (const it of items) {
    const o = outcomes.get(it.variantId)!;
    const node = live.get(it.variantId);
    if (!node) {
      o.status = "missing";
      o.errors.general = "This variant no longer exists in Shopify.";
      continue;
    }
    const expected = it.expectedUpdatedAt ?? snapBy.get(it.variantId)?.updatedAt ?? null;
    if (expected && new Date(node.updatedAt).getTime() > new Date(expected).getTime()) {
      // UC-04 A1 / E-10: changed in Shopify since the merchant saw it. Refresh our copy; don't overwrite.
      o.status = "conflict";
      o.errors.general = "This product changed in Shopify. Reload to see the latest values.";
      await refreshSnapshots(db, ctx.shopId, [node]);
      continue;
    }
    const old = currentValues(node);
    const norm = normalizeChange(it.changes);
    const diff: VariantChange = {};
    for (const f of Object.keys(norm) as EditableField[]) {
      const nv = (norm as any)[f];
      if (nv === undefined) continue;
      if ((old as any)[f] !== nv) (diff as any)[f] = nv;
    }
    if (Object.keys(diff).length === 0) continue;
    plans.push({ item: it, node, diff, old });
  }

  // 1) SKU + barcode, grouped per product.
  const byProduct = new Map<string, Plan[]>();
  const newLists = new Map<string, BarcodeEntry[]>();
  for (const p of plans) {
    const list2 = hasBarcodeList(p.node) ? nextBarcodes(p.node, p.diff) : null;
    if (list2) newLists.set(p.node.id, list2);
    if (!("sku" in p.diff) && !("barcode" in p.diff) && !list2) continue;
    const list = byProduct.get(p.node.product.id) ?? [];
    list.push(p);
    byProduct.set(p.node.product.id, list);
  }
  for (const [productId, list] of byProduct) {
    const variants = list.map((p) => {
      const bl = newLists.get(p.node.id);
      return {
        id: p.node.id,
        ...(bl ? { barcodes: bl } : "barcode" in p.diff ? { barcode: p.diff.barcode ?? "" } : {}),
        ...("sku" in p.diff ? { inventoryItem: { sku: p.diff.sku ?? "" } } : {}),
      };
    });
    try {
      const res = await gql<any>(VARIANTS_BULK_UPDATE, { productId, variants });
      const errs: { field?: string[]; message: string }[] = res?.productVariantsBulkUpdate?.userErrors ?? [];
      const failedIdx = new Map<number, string>();
      for (const e of errs) {
        const idx = Number(e.field?.[1]);
        failedIdx.set(Number.isFinite(idx) ? idx : -1, e.message);
      }
      list.forEach((p, i) => {
        const msg = failedIdx.get(i) ?? failedIdx.get(-1);
        const o = outcomes.get(p.node.id)!;
        if (msg) {
          // UC-04 A2: show the error inline, keep the edit.
          if ("sku" in p.diff) o.errors.sku = msg;
          if ("barcode" in p.diff) o.errors.barcode = msg;
        } else {
          if ("sku" in p.diff) o.written.push("sku");
          if ("barcode" in p.diff) o.written.push("barcode");
        }
      });
    } catch (e: any) {
      for (const p of list) outcomes.get(p.node.id)!.errors.general = String(e?.message ?? e);
    }
  }

  // 2) Metafields (NS-PID set/delete, no-barcode flag).
  const sets: { ownerId: string; namespace: string; key: string; type: string; value: string; field: EditableField }[] = [];
  const deletes: { ownerId: string; namespace: string; key: string }[] = [];
  for (const p of plans) {
    if ("nspid" in p.diff) {
      if (p.diff.nspid) sets.push({ ownerId: p.node.id, namespace: k.namespace, key: k.key, type: "single_line_text_field", value: p.diff.nspid, field: "nspid" });
      else deletes.push({ ownerId: p.node.id, namespace: k.namespace, key: k.key });
    }
    if ("noStandardIdentifier" in p.diff) {
      sets.push({ ownerId: p.node.id, namespace: NOSTD.namespace, key: NOSTD.key, type: NOSTD.type, value: String(!!p.diff.noStandardIdentifier), field: "noStandardIdentifier" });
    }
  }
  for (const c of chunk(sets, 25)) {
    try {
      const res = await gql<any>(METAFIELDS_SET, { metafields: c.map(({ field: _f, ...m }) => m) });
      const errs: { field?: string[]; message: string }[] = res?.metafieldsSet?.userErrors ?? [];
      const bad = new Map<number, string>();
      for (const e of errs) bad.set(Number(e.field?.[1] ?? -1), e.message);
      // metafieldsSet is atomic: any error means none were written.
      c.forEach((m, i) => {
        const o = outcomes.get(m.ownerId)!;
        if (errs.length) o.errors[m.field] = bad.get(i) ?? errs[0]!.message;
        else o.written.push(m.field);
      });
    } catch (e: any) {
      for (const m of c) outcomes.get(m.ownerId)!.errors[m.field] = String(e?.message ?? e);
    }
  }
  for (const c of chunk(deletes, 25)) {
    try {
      await gql(METAFIELDS_DELETE, { metafields: c });
      for (const m of c) outcomes.get(m.ownerId)!.written.push("nspid");
    } catch (e: any) {
      for (const m of c) outcomes.get(m.ownerId)!.errors.nspid = String(e?.message ?? e);
    }
  }

  // 3) HS code and origin per inventory item.
  for (const p of plans) {
    const input: Record<string, string | null> = {};
    if ("hsCode" in p.diff) input.harmonizedSystemCode = p.diff.hsCode ?? null;
    if ("countryOfOrigin" in p.diff) input.countryCodeOfOrigin = p.diff.countryOfOrigin ?? null;
    if (!Object.keys(input).length || !p.node.inventoryItem?.id) continue;
    const o = outcomes.get(p.node.id)!;
    try {
      const res = await gql<any>(INVENTORY_ITEM_UPDATE, { id: p.node.inventoryItem.id, input });
      const errs = res?.inventoryItemUpdate?.userErrors ?? [];
      if (errs.length) {
        if ("hsCode" in p.diff) o.errors.hsCode = errs[0].message;
        if ("countryOfOrigin" in p.diff) o.errors.countryOfOrigin = errs[0].message;
      } else {
        if ("hsCode" in p.diff) o.written.push("hsCode");
        if ("countryOfOrigin" in p.diff) o.written.push("countryOfOrigin");
      }
    } catch (e: any) {
      o.errors.general = String(e?.message ?? e);
    }
  }

  // 4) Status, audit, refresh snapshots from Shopify, re-evaluate.
  const auditRows: any[] = [];
  for (const p of plans) {
    const o = outcomes.get(p.node.id)!;
    o.status = o.written.length ? "saved" : Object.keys(o.errors).length ? "error" : "unchanged";
    if (o.written.length && Object.keys(o.errors).length) o.status = "saved"; // partial; errors still reported
    for (const f of o.written) {
      auditRows.push({
        shopId: ctx.shopId,
        actor: ctx.actor,
        action: ctx.auditAction ?? "variant_update",
        variantId: p.node.id,
        field: f,
        oldValue: stringify((p.old as any)[f]),
        newValue: stringify((p.diff as any)[f]),
      });
    }
  }
  if (auditRows.length && opts.audit !== "none") await db.auditLog.createMany({ data: auditRows });

  const touched = plans.filter((p) => outcomes.get(p.node.id)!.written.length).map((p) => p.node.id);
  if (touched.length) {
    const fresh = await fetchNodes(gql, k, touched);
    await refreshSnapshots(db, ctx.shopId, [...fresh.values()]);
  }
  if (opts.reevaluate !== false && (touched.length || [...outcomes.values()].some((o) => o.status === "conflict"))) {
    await reevaluateShop(db, ctx.shopId, { source: "write" });
  }
  return items.map((i) => outcomes.get(i.variantId)!);
}

function stringify(v: unknown) {
  return v == null ? null : String(v);
}

export async function refreshSnapshots(db: PrismaClient, shopId: string, nodes: VariantNode[]) {
  if (!nodes.length) return;
  // Keep the scan id of existing rows; new rows get none. Flags are set by the evaluator.
  const rows = nodes.map((n) => nodeToSnapshot(shopId, n, null));
  await upsertSnapshots(db, rows, { keepScanId: true });
}

/**
 * Zonos and Passport read the manufacturer code from the variant's barcode list, not from a
 * metafield. Append the stored code (metafield) as an extra untyped barcode, keeping every
 * existing barcode first and in order. Shopify's API has no NS-PID barcode type, so the entry
 * has no type. Variants already carrying it, or with 20 barcodes, are skipped.
 */
export async function addNspidToBarcodes(db: PrismaClient, gql: Gql, ctx: WriteCtx, variantIds: string[]): Promise<WriteOutcome[]> {
  const k = await nspidKey(db, ctx.shopId);
  const live = await fetchNodes(gql, k, variantIds);
  const outcomes = new Map<string, WriteOutcome>();
  for (const id of variantIds) outcomes.set(id, { variantId: id, status: "unchanged", written: [], errors: {} });
  const byProduct = new Map<string, { id: string; barcodes: BarcodeEntry[]; value: string }[]>();
  for (const id of variantIds) {
    const n = live.get(id);
    const o = outcomes.get(id)!;
    if (!n) {
      o.status = "missing";
      o.errors.general = "This variant no longer exists in Shopify.";
      continue;
    }
    const value = n.nspid?.value?.trim();
    if (!value) continue;
    if (!hasBarcodeList(n)) {
      o.status = "error";
      o.errors.general = "This store's Shopify version can't hold more than one barcode yet.";
      continue;
    }
    const list = barcodeList(n).map((b) => ({ value: b.value, type: b.type ?? null }));
    if (list.some((b) => b.value.trim() === value)) continue;
    if (list.length >= 20) {
      o.status = "error";
      o.errors.general = "This variant already has 20 barcodes, Shopify's maximum.";
      continue;
    }
    const arr = byProduct.get(n.product.id) ?? [];
    arr.push({ id, barcodes: [...list, { value, type: null }], value });
    byProduct.set(n.product.id, arr);
  }
  const audits: any[] = [];
  for (const [productId, list] of byProduct) {
    try {
      const res = await gql<any>(VARIANTS_BULK_UPDATE, { productId, variants: list.map((v) => ({ id: v.id, barcodes: v.barcodes })) });
      const errs: { field?: string[]; message: string }[] = res?.productVariantsBulkUpdate?.userErrors ?? [];
      const failedIdx = new Map<number, string>();
      for (const e of errs) {
        const idx = Number(e.field?.[1]);
        failedIdx.set(Number.isFinite(idx) ? idx : -1, e.message);
      }
      list.forEach((v, i) => {
        const o = outcomes.get(v.id)!;
        const msg = failedIdx.get(i) ?? failedIdx.get(-1);
        if (msg) {
          o.status = "error";
          o.errors.general = msg;
        } else {
          o.status = "saved";
          o.written.push("nspid");
          audits.push({ shopId: ctx.shopId, actor: ctx.actor, action: "nspid_to_barcodes", variantId: v.id, field: "barcodes", newValue: v.value });
        }
      });
    } catch (e: any) {
      for (const v of list) {
        const o = outcomes.get(v.id)!;
        o.status = "error";
        o.errors.general = String(e?.message ?? e);
      }
    }
  }
  if (audits.length) await db.auditLog.createMany({ data: audits });
  const touched = [...outcomes.values()].filter((o) => o.status === "saved").map((o) => o.variantId);
  if (touched.length) {
    const fresh = await fetchNodes(gql, k, touched);
    await refreshSnapshots(db, ctx.shopId, [...fresh.values()]);
  }
  return variantIds.map((id) => outcomes.get(id)!);
}
