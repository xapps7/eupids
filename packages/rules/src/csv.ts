// Minimal RFC 4180 CSV parser and writer. No dependencies, runs in the browser (UC-17).

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let i = 0;
  let inQuotes = false;
  if (text.charCodeAt(0) === 0xfeff) i = 1; // BOM

  while (i < text.length) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
    } else if (ch === ",") {
      row.push(field);
      field = "";
      i++;
    } else if (ch === "\n" || ch === "\r") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      if (ch === "\r" && text[i + 1] === "\n") i++;
      i++;
    } else {
      field += ch;
      i++;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // drop fully empty trailing lines
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

export function toCsv(rows: (string | number | boolean | null | undefined)[][]): string {
  return rows
    .map((r) =>
      r
        .map((c) => {
          const s = c == null ? "" : String(c);
          return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        })
        .join(","),
    )
    .join("\r\n");
}
