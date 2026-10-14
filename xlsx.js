// Minimal .xlsx reader (first worksheet → rows of strings). Browser only: uses DecompressionStream + DOMParser.
// Needed because Android often hands over a CSV that Google Sheets/Drive or Excel turned into .xlsx.

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

async function unzip(buf) {
  const b = new Uint8Array(buf);
  let e = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 66000); i--) if (u32(b, i) === 0x06054b50) { e = i; break; }
  if (e < 0) throw new Error('Not a valid spreadsheet file');
  const count = u16(b, e + 10);
  let p = u32(b, e + 16);
  const files = {};
  const dec = new TextDecoder();
  for (let k = 0; k < count; k++) {
    if (u32(b, p) !== 0x02014b50) break;
    const method = u16(b, p + 10), csize = u32(b, p + 20), nlen = u16(b, p + 28), xlen = u16(b, p + 30), clen = u16(b, p + 32), off = u32(b, p + 42);
    const name = dec.decode(b.subarray(p + 46, p + 46 + nlen));
    files[name] = { method, csize, off };
    p += 46 + nlen + xlen + clen;
  }
  return {
    names: Object.keys(files),
    async text(name) {
      const f = files[name];
      if (!f) return null;
      const start = f.off + 30 + u16(b, f.off + 26) + u16(b, f.off + 28);
      const data = b.subarray(start, start + f.csize);
      if (f.method === 0) return dec.decode(data);
      if (f.method !== 8) throw new Error('Unsupported compression in spreadsheet');
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return new Response(stream).text();
    },
  };
}

const colIndex = (ref) => { let n = 0; for (const ch of ref.replace(/\d+$/, '')) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };

export async function xlsxRows(buf) {
  const zip = await unzip(buf);
  const parse = (x) => new DOMParser().parseFromString(x, 'application/xml');
  const shared = [];
  const ss = await zip.text('xl/sharedStrings.xml');
  if (ss) for (const si of parse(ss).getElementsByTagName('si')) shared.push([...si.getElementsByTagName('t')].map((t) => t.textContent).join(''));
  const sheet = zip.names.filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort((a, b) => parseInt(a.match(/\d+/)) - parseInt(b.match(/\d+/)))[0];
  if (!sheet) throw new Error('No worksheet found in the spreadsheet');
  const doc = parse(await zip.text(sheet));
  const rows = [];
  for (const r of doc.getElementsByTagName('row')) {
    const row = [];
    for (const c of r.getElementsByTagName('c')) {
      const t = c.getAttribute('t');
      const v = c.getElementsByTagName('v')[0]?.textContent ?? '';
      let val;
      if (t === 's') val = shared[+v] ?? '';
      else if (t === 'inlineStr') val = [...c.getElementsByTagName('t')].map((x) => x.textContent).join('');
      else if (t === 'b') val = v === '1' ? 'TRUE' : 'FALSE';
      else val = v;
      const ref = c.getAttribute('r');
      const i = ref ? colIndex(ref) : row.length;
      while (row.length < i) row.push('');
      row[i] = val;
    }
    if (row.some((x) => x !== '')) rows.push(row);
  }
  return rows;
}

// Rows → CSV text, so the normal IBKR parser can read it.
export const rowsToCsv = (rows) => rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\n');
