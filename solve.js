// Faster drop-in for csv-reader 1.0.0 (make.fun csv-reader-speed-01).
// Single left-to-right pass. Unquoted fields and quoted fields both jump
// straight to the next delimiter with indexOf instead of scanning
// character by character, which is where the baseline spends its time.
// Semantics follow the spec exactly: BOM dropped, stray CR dropped with
// an error, doubled quotes collapse, CRLF/lone CR inside quotes become
// LF, junk after a closing quote is appended with a quote_junk error, an
// unterminated quote becomes literal and the rest is re-read unquoted,
// short rows pad, long rows cut, errors carry {code, line, row}.

const COMMA = 44; // ,
const QUOTE = 34; // "
const CR = 13; // \r
const LF = 10; // \n
const BOM = 0xfeff;

export function run(input) {
  const text = String(input.text);
  const n = text.length;
  const header = input.header === true;
  const rows = [];
  const errors = [];

  let columns = null;
  let width = -1;
  // Skip a leading BOM.
  let pos = text.charCodeAt(0) === BOM ? 1 : 0;
  let line = 1;
  // Per-record bookkeeping, reset at the start of every record.
  let recordLine = 1;
  let recordRow = null;
  // Value of the field just read, and how the field ended:
  // 0 = comma (more fields follow), 1 = line break (record done),
  // 2 = end of input.
  let fieldValue = '';
  let fieldEnd = 2;
  // Set by readField when it appended any characters (used to tell
  // whether there was junk after a closing quote).
  let appended = false;

  // Read an unquoted field starting at pos. `prefix` is prepended when
  // this is the junk tail of a quoted field (the quoted part is the
  // prefix, the junk read here is appended to it).
  function readField(prefix) {
    let i = pos;
    let start = i;
    let parts = null;
    appended = false;

    for (;;) {
      // Find the nearest of comma / LF / CR from i.
      let comma = text.indexOf(',', i);
      let lf = text.indexOf('\n', i);
      let cr = text.indexOf('\r', i);
      if (comma < 0) comma = n;
      if (lf < 0) lf = n;
      if (cr < 0) cr = n;
      const stop = comma < lf ? (comma < cr ? comma : cr) : (lf < cr ? lf : cr);

      // No delimiter left: the rest of the input is the field.
      if (stop >= n) {
        if (n > start) appended = true;
        if (parts) parts.push(text.slice(start, n));
        const value = parts ? parts.join('') : text.slice(start, n);
        fieldValue = prefix ? prefix + value : value;
        pos = n;
        fieldEnd = 2;
        return;
      }

      const c = text.charCodeAt(stop);

      // Lone CR outside quotes: dropped, error, keep scanning.
      if (c === CR && !(stop + 1 < n && text.charCodeAt(stop + 1) === LF)) {
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        appended = true;
        if (!parts) parts = [];
        parts.push(text.slice(start, stop));
        i = stop + 1;
        start = i;
        continue;
      }

      if (stop > start) appended = true;
      if (parts) parts.push(text.slice(start, stop));
      const value = parts ? parts.join('') : text.slice(start, stop);
      fieldValue = prefix ? prefix + value : value;

      if (c === COMMA) {
        pos = stop + 1;
        fieldEnd = 0;
      } else if (c === CR) {
        pos = stop + 2; // CRLF
        line++;
        fieldEnd = 1;
      } else {
        pos = stop + 1; // LF
        line++;
        fieldEnd = 1;
      }
      return;
    }
  }

  // Read a field that opens with a quote at pos.
  function readQuotedField() {
    const open = pos;
    const openLine = line;
    let i = open + 1;
    let segment = i;
    let parts = null;

    for (;;) {
      // Find the nearest of quote / CR / LF from i.
      let quote = text.indexOf('"', i);
      let cr = text.indexOf('\r', i);
      let lf = text.indexOf('\n', i);
      if (quote < 0) quote = n;
      if (cr < 0) cr = n;
      if (lf < 0) lf = n;
      const stop = quote < cr ? (quote < lf ? quote : lf) : (cr < lf ? cr : lf);

      // No quote found before the end: unterminated. The opening quote
      // becomes a literal character and the rest is re-read unquoted.
      if (stop >= n) break;

      const c = text.charCodeAt(stop);

      if (c === QUOTE) {
        // Doubled quote inside: one literal quote, keep going.
        if (stop + 1 < n && text.charCodeAt(stop + 1) === QUOTE) {
          if (!parts) parts = [];
          parts.push(text.slice(segment, stop), '"');
          i = stop + 2;
          segment = i;
          continue;
        }
        // Closing quote.
        i = stop;
        break;
      }

      // CR or LF inside quotes: becomes LF, line advances.
      if (!parts) parts = [];
      parts.push(text.slice(segment, stop), '\n');
      if (c === CR && stop + 1 < n && text.charCodeAt(stop + 1) === LF) {
        i = stop + 2;
      } else {
        i = stop + 1;
      }
      segment = i;
      line++;
    }

    // Unterminated: rewind and re-read as unquoted with a literal quote.
    if (i >= n || text.charCodeAt(i) !== QUOTE) {
      pos = open + 1;
      line = openLine;
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      readField('"');
      return;
    }

    // Quoted content, with doubled quotes collapsed and inner line
    // breaks normalised to LF.
    if (parts) parts.push(text.slice(segment, i));
    fieldValue = parts ? parts.join('') : text.slice(open + 1, i);
    pos = i + 1;

    if (pos >= n) {
      fieldEnd = 2;
      return;
    }

    const c = text.charCodeAt(pos);
    if (c === COMMA) {
      pos++;
      fieldEnd = 0;
      return;
    }
    if (c === LF) {
      pos++;
      line++;
      fieldEnd = 1;
      return;
    }
    if (c === CR && pos + 1 < n && text.charCodeAt(pos + 1) === LF) {
      pos += 2;
      line++;
      fieldEnd = 1;
      return;
    }

    // Junk after the closing quote: appended as-is, error when the
    // field ends (only if there actually was junk).
    readField(fieldValue);
    if (appended) {
      errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
    }
  }

  for (;;) {
    // Skip blank lines at the start of a record (LF or CRLF).
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === LF) {
        pos++;
        line++;
      } else if (c === CR && pos + 1 < n && text.charCodeAt(pos + 1) === LF) {
        pos += 2;
        line++;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    const fields = [];
    let quoted;
    do {
      quoted = text.charCodeAt(pos) === QUOTE;
      if (quoted) readQuotedField();
      else readField('');
      fields.push(fieldValue);
    } while (fieldEnd === 0);

    // A lone empty unquoted field on its own line is no record.
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }

    if (fields.length < width) {
      errors.push({
        code: 'short_row',
        line: recordLine,
        row: recordRow,
        fields: fields.length
      });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      const extra = fields.slice(width);
      fields.length = width;
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra });
    }

    rows.push(fields);
  }

  return { columns: header ? (columns ?? []) : null, rows, errors };
}
