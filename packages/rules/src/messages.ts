// PRD Section 9 "Message shown". Plain English, short sentences (8b copy rules).
import type { RuleCode, Severity } from "./types.js";

export const RULES: Record<RuleCode, { severity: Severity; message: string; checks: string }> = {
  "R-MPID-01": { severity: "error", message: "Add a SKU. Customs uses it as your product code.", checks: "SKU is empty or a placeholder" },
  "R-MPID-02": { severity: "error", message: "This SKU is used by {n} other variants. Each variant needs its own.", checks: "SKU is shared with another in-scope variant" },
  "R-NSPID-01": { severity: "error", message: "Add the manufacturer’s code for this item.", checks: "NS-PID is empty or a placeholder" },
  "R-NSPID-02": { severity: "warning", message: "Manufacturer code matches your SKU. Check it is the maker’s code.", checks: "NS-PID equals the SKU and vendor is not own-brand" },
  "R-NSPID-03": { severity: "info", message: "You marked this vendor as your own brand.", checks: "NS-PID equals the SKU and vendor is own-brand" },
  "R-NSPID-04": { severity: "error", message: "Manufacturer code is too long or has invalid characters.", checks: "NS-PID longer than 70 characters or has control characters" },
  // E-16 / Q-04. Not in the Section 9 table; added so E-16 ("accept; warn") has a code. Remove or retune once Q-04 is answered.
  "R-NSPID-05": { severity: "warning", message: "Manufacturer code has non-Latin characters. Your carrier may need Latin letters.", checks: "NS-PID contains characters outside the Latin script" },
  "R-SPID-01": { severity: "error", message: "Add a barcode, or confirm this item has none.", checks: "No barcode and no-barcode flag not set" },
  "R-SPID-02": { severity: "error", message: "Barcode must be 8, 12, 13 or 14 digits.", checks: "Barcode is not 8, 12, 13 or 14 digits after normalization" },
  "R-SPID-03": { severity: "error", message: "This barcode’s last digit is wrong. It is likely mistyped.", checks: "Check digit fails (D-06)" },
  "R-SPID-04": { severity: "error", message: "This isn’t a real barcode. Add the real one or confirm none exists.", checks: "Barcode is a placeholder or equals the SKU" },
  "R-SPID-05": { severity: "error", message: "Internal codes don’t count. Add a GTIN/EAN/UPC or confirm none.", checks: "Barcode looks internal (letters, e.g. an Amazon ASIN)" },
  "R-SPID-06": { severity: "warning", message: "This barcode is also on another product. Check it.", checks: "Same barcode on variants of different products" },
  "R-SPID-07": { severity: "warning", message: "You have a barcode and also marked “none”. Pick one.", checks: "Barcode present and no-barcode flag also true" },
  "R-HS-01": { severity: "warning", message: "Add an HS code. It sets the EU €3 duty per product type.", checks: "HS code empty" },
  "R-HS-02": { severity: "warning", message: "HS codes are 6–10 digits.", checks: "HS code not 6–10 digits" },
  "R-COO-01": { severity: "warning", message: "Add the country where this item was made.", checks: "Country of origin empty" },
};

export const DISCLAIMER = "PID Ready checks your data. It is not legal or customs advice.";
