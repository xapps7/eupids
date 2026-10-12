// Field-level checks used by inline edit, CSV import and supplier submissions.
// Same rule engine helpers as the scan (UC-04: "the same rule engine").
import { buildPlaceholderSet, isPlaceholder, isValidGtin, normalizeBarcode } from "@pidready/rules";

export type EditableField = "sku" | "barcode" | "nspid" | "noStandardIdentifier" | "hsCode" | "countryOfOrigin";
export type VariantChange = Partial<{
  sku: string | null;
  barcode: string | null;
  nspid: string | null;
  noStandardIdentifier: boolean;
  hsCode: string | null;
  countryOfOrigin: string | null;
}>;

const CONTROL = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}]/u;

/** Normalize values the way we store them (E-02: barcode without spaces/hyphens). */
export function normalizeChange(c: VariantChange): VariantChange {
  const out: VariantChange = { ...c };
  const t = (v: string | null | undefined) => (v == null ? v : v.trim());
  if ("sku" in c) out.sku = t(c.sku) || null;
  if ("barcode" in c) out.barcode = c.barcode == null ? null : normalizeBarcode(c.barcode) || null;
  if ("nspid" in c) out.nspid = t(c.nspid) || null;
  if ("hsCode" in c) out.hsCode = c.hsCode == null ? null : c.hsCode.replace(/[\s.]/g, "") || null;
  if ("countryOfOrigin" in c) out.countryOfOrigin = t(c.countryOfOrigin)?.toUpperCase() || null;
  return out;
}

export function fieldErrors(c: VariantChange, extraPlaceholders: string[] = []): Partial<Record<EditableField, string>> {
  const ph = buildPlaceholderSet(extraPlaceholders);
  const e: Partial<Record<EditableField, string>> = {};
  if ("sku" in c && c.sku != null && isPlaceholder(c.sku, ph)) e.sku = "This looks like a placeholder, not a SKU.";
  if ("barcode" in c && c.barcode) {
    if (/[^0-9]/.test(c.barcode)) e.barcode = "Barcodes are digits only (GTIN, EAN, UPC or ISBN-13).";
    else if (![8, 12, 13, 14].includes(c.barcode.length)) e.barcode = "Barcode must be 8, 12, 13 or 14 digits.";
    else if (!isValidGtin(c.barcode)) e.barcode = "This barcode’s last digit is wrong. It is likely mistyped.";
  }
  if ("nspid" in c && c.nspid) {
    if (c.nspid.length > 70 || CONTROL.test(c.nspid)) e.nspid = "Manufacturer code is too long or has invalid characters.";
    else if (isPlaceholder(c.nspid, ph)) e.nspid = "This looks like a placeholder, not a manufacturer code.";
  }
  if ("hsCode" in c && c.hsCode && !/^\d{6,10}$/.test(c.hsCode)) e.hsCode = "HS codes are 6–10 digits.";
  if ("countryOfOrigin" in c && c.countryOfOrigin && !/^[A-Z]{2}$/.test(c.countryOfOrigin))
    e.countryOfOrigin = "Use the two-letter country code, like IN or CN.";
  return e;
}
