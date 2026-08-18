/**
 * Minimal RFC 4180 CSV reader.
 *
 * Written rather than pulled in because the one file it has to read — the City of Toronto
 * child care export — carries a quoted GeoJSON blob in its last column, full of commas and
 * doubled quotes. A naive split on "," silently mangles every row.
 */
export function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  // Strip a UTF-8 BOM: it would otherwise become part of the first header name.
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;

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
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (ch === '\r') {
      i += 1;
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

/** Rows as objects keyed by the header line. */
export function parseCsvRecords(input: string): Record<string, string>[] {
  const rows = parseCsv(input);
  const header = rows[0];
  if (!header) return [];

  return rows.slice(1).map((cells) => {
    const record: Record<string, string> = {};
    header.forEach((name, idx) => {
      record[name.trim()] = cells[idx] ?? '';
    });
    return record;
  });
}
