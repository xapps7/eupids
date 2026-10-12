// D-04, D-06, E-01, E-04 — standard barcode helpers.

/** E-02: strip spaces and hyphens (and trim). */
export function normalizeBarcode(value: string): string {
  return value.trim().replace(/[\s-]+/g, "");
}

export const GTIN_LENGTHS = [8, 12, 13, 14] as const;

/**
 * D-06: take the digits without the last one. From the right, multiply
 * alternately by 3 and 1. Check digit = (10 − (sum mod 10)) mod 10.
 * Input: the body (all digits except the check digit).
 */
export function gtinCheckDigit(body: string): number {
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    const digit = body.charCodeAt(body.length - 1 - i) - 48;
    sum += digit * (i % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10;
}

export function hasValidCheckDigit(code: string): boolean {
  if (!/^\d{2,}$/.test(code)) return false;
  const body = code.slice(0, -1);
  const last = code.charCodeAt(code.length - 1) - 48;
  return gtinCheckDigit(body) === last;
}

/** D-04: GTIN-8, UPC-A (12), EAN-13 (incl. ISBN-13 978/979), GTIN-14, with a valid check digit. */
export function isValidGtin(code: string): boolean {
  return (
    /^\d+$/.test(code) &&
    (GTIN_LENGTHS as readonly number[]).includes(code.length) &&
    hasValidCheckDigit(code)
  );
}

/** E-04: ISBN-10 (9 digits + digit or X) with a valid mod-11 check. */
export function isIsbn10(code: string): boolean {
  if (!/^\d{9}[\dXx]$/.test(code)) return false;
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    const ch = code[i]!;
    const v = ch === "X" || ch === "x" ? 10 : Number(ch);
    sum += v * (10 - i);
  }
  return sum % 11 === 0;
}

/** E-04: ISBN-10 → ISBN-13 (978 prefix, recomputed check digit). */
export function isbn10To13(code: string): string {
  const body = "978" + code.slice(0, 9);
  return body + String(gtinCheckDigit(body));
}

/**
 * E-01: an 11-digit UPC-A that lost its leading zero in a spreadsheet.
 * Returns the 12-digit value if prepending "0" makes the check digit pass.
 */
export function suggestLeadingZero(code: string): string | null {
  if (!/^\d{11}$/.test(code)) return null;
  const padded = "0" + code;
  return hasValidCheckDigit(padded) ? padded : null;
}

/**
 * Parse a Shopify "Barcodes" cell (Sep 2026 export), e.g.
 * "gtin:00012345678905; upc:012345678905; INTERNAL-123".
 * Returns raw values with the type label removed, in order.
 */
export function splitTypedBarcodes(cell: string): string[] {
  return cell
    .split(/[;|\n]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const m = /^([a-z0-9_ -]{2,12}):\s*(.+)$/i.exec(part);
      return m ? m[2]!.trim() : part;
    });
}
