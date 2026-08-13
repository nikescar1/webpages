/**
 * Minimal RFC4180 CSV parser.
 *
 * nflverse ships real-world CSV: quoted fields containing commas (college
 * names, "Smith, Jr."), embedded newlines, and doubled quotes. A naive
 * split(',') corrupts roughly 1% of rows, so we parse properly.
 */

/** Parse a CSV string into an array of row-arrays. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  // Strip a UTF-8 BOM if present.
  if (text.charCodeAt(0) === 0xfeff) i = 1;

  for (; i < text.length; i++) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      // Treat \r\n as a single terminator.
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }

  // Flush a trailing field/row when the file has no final newline.
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

/**
 * Parse CSV into objects keyed by header name.
 *
 * `columns` optionally restricts which columns are kept — the nflverse weekly
 * stats file has 145 columns and we only need ~40, so filtering here keeps a
 * full season under the Durable Object value size limit.
 */
export function parseCsvObjects(text, columns = null) {
  const rows = parseCsv(text);
  if (rows.length === 0) return [];

  const header = rows[0];
  const keep = columns
    ? header.map((h) => columns.includes(h))
    : header.map(() => true);

  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    // Skip blank trailing lines.
    if (cells.length === 1 && cells[0] === '') continue;

    const obj = {};
    for (let c = 0; c < header.length; c++) {
      if (!keep[c]) continue;
      obj[header[c]] = cells[c] === undefined ? '' : cells[c];
    }
    out.push(obj);
  }
  return out;
}

/** Coerce a CSV cell to a number. nflverse writes empty string and "NA" for missing. */
export function num(v) {
  if (v === undefined || v === null || v === '' || v === 'NA') return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
