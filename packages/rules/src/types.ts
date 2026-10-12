// PRD Section 9 — engine contract. Additive fields are marked "extension".

export type ProductStatus = "ACTIVE" | "DRAFT" | "ARCHIVED";

export type VariantInput = {
  id: string;
  productId: string;
  vendor: string;
  status: ProductStatus;
  requiresShipping: boolean;
  isGiftCard: boolean;
  sku: string | null;
  /** All stored barcode values, in stored order (D-04, E-03). */
  barcodes: string[];
  nspid: string | null;
  noStandardIdentifier: boolean;
  hsCode: string | null;
  countryOfOrigin: string | null;
};

export type Severity = "error" | "warning" | "info";

export type RuleCode =
  | "R-MPID-01"
  | "R-MPID-02"
  | "R-NSPID-01"
  | "R-NSPID-02"
  | "R-NSPID-03"
  | "R-NSPID-04"
  | "R-NSPID-05"
  | "R-SPID-01"
  | "R-SPID-02"
  | "R-SPID-03"
  | "R-SPID-04"
  | "R-SPID-05"
  | "R-SPID-06"
  | "R-SPID-07"
  | "R-HS-01"
  | "R-HS-02"
  | "R-COO-01";

export type Issue = {
  variantId: string;
  code: RuleCode;
  severity: Severity;
  message: string;
  /** extension: a suggested fix the merchant can accept. Never auto-applied (E-01, E-04). */
  suggestion?: string;
};

export type RuleSettings = {
  /** UC-10: include DRAFT products in scope. Default false. */
  includeDraft: boolean;
  /** D-09: vendors the merchant marked "we are the manufacturer". Matched case-insensitively. */
  ownBrandVendors: string[];
  /** D-07: extra placeholder values from Settings. */
  extraPlaceholders: string[];
  /** UC-10: treat missing HS code and origin as errors. Default false. */
  hsAsError: boolean;
  /**
   * extension: rule codes to skip entirely. Used by the free checker when the
   * uploaded CSV has no HS code / origin columns, so we don't flag data that
   * simply isn't in the file.
   */
  skipRules?: RuleCode[];
};

export const DEFAULT_SETTINGS: RuleSettings = {
  includeDraft: false,
  ownBrandVendors: [],
  extraPlaceholders: [],
  hsAsError: false,
  skipRules: [],
};

export type VariantResult = {
  variantId: string;
  inScope: boolean;
  /** In scope and zero error-level issues. */
  ready: boolean;
  /** The chosen S-PID (first valid standard barcode), normalized. */
  spid: string | null;
  /** "Y081" when the no-barcode flag is set and no real barcode is stored. */
  spidException: "Y081" | null;
  /** Other stored barcode values, shown read-only (E-03). */
  otherBarcodes: string[];
};

export type EvaluateResult = {
  inScope: number;
  ready: number;
  /** extension: counted, never flagged (D-01, E-07, E-08). */
  outOfScope: number;
  issues: Issue[];
  /** extension: per-variant status, in input order. */
  results: VariantResult[];
};
