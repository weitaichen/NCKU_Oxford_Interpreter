// Markdown → 真正的 .docx
//
// .docx 本質上是一個 ZIP，裡面放 OOXML。這裡自己組 ZIP（用 stored 不壓縮，
// 筆記檔案才幾 KB，省下實作 DEFLATE 的複雜度）與最小可用的 OOXML 部件。
// 不引入任何外部套件，維持整個專案零相依。
//
// 產出的是合規的 .docx，Word、Google 文件、LibreOffice 都能正常開啟並保留格式。

(function (root) {
  'use strict';

  // ---------- CRC32（ZIP 需要）----------

  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  // ---------- ZIP（stored，不壓縮）----------

  function zip(files) {
    const enc = new TextEncoder();
    const chunks = [];
    const central = [];
    let offset = 0;

    const u16 = (v) => [v & 0xff, (v >>> 8) & 0xff];
    const u32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];

    for (const { name, content } of files) {
      const nameBytes = enc.encode(name);
      const data = enc.encode(content);
      const crc = crc32(data);

      const local = [
        ...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0),
        ...u16(0), ...u16(0),                        // 時間戳固定為 0
        ...u32(crc), ...u32(data.length), ...u32(data.length),
        ...u16(nameBytes.length), ...u16(0),
      ];
      chunks.push(new Uint8Array(local), nameBytes, data);

      central.push([
        ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0),
        ...u16(0), ...u16(0),
        ...u32(crc), ...u32(data.length), ...u32(data.length),
        ...u16(nameBytes.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
        ...u32(0), ...u32(offset),
        ...Array.from(nameBytes),
      ]);
      offset += local.length + nameBytes.length + data.length;
    }

    const centralBytes = new Uint8Array(central.flat());
    chunks.push(centralBytes);
    chunks.push(new Uint8Array([
      ...u32(0x06054b50), ...u16(0), ...u16(0),
      ...u16(files.length), ...u16(files.length),
      ...u32(centralBytes.length), ...u32(offset), ...u16(0),
    ]));

    let total = 0;
    for (const c of chunks) total += c.length;
    const out = new Uint8Array(total);
    let p = 0;
    for (const c of chunks) { out.set(c, p); p += c.length; }
    return out;
  }

  // ---------- OOXML ----------

  const XML_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
  const x = (s) => String(s).replace(/[&<>"']/g, (c) => XML_ESC[c]);

  // 中文要指定東亞字型，否則 Word 可能用預設字型導致字距怪異
  const FONTS = '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Microsoft JhengHei"/>';

  function run(text, { bold, size, code } = {}) {
    if (!text) return '';
    const props =
      '<w:rPr>' +
      (code ? '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="Microsoft JhengHei"/>' : FONTS) +
      (bold ? '<w:b/>' : '') +
      (size ? `<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>` : '') +
      '</w:rPr>';
    return `<w:r>${props}<w:t xml:space="preserve">${x(text)}</w:t></w:r>`;
  }

  // 把 **粗體** 與 `程式碼` 拆成多個 run
  function runs(text, base = {}) {
    const parts = [];
    const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
    let last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) parts.push(run(text.slice(last, m.index), base));
      const token = m[0];
      if (token.startsWith('**')) parts.push(run(token.slice(2, -2), { ...base, bold: true }));
      else parts.push(run(token.slice(1, -1), { ...base, code: true }));
      last = re.lastIndex;
    }
    if (last < text.length) parts.push(run(text.slice(last), base));
    return parts.join('') || run(text, base);
  }

  function para(content, { indent = 0, spaceBefore = 0, spaceAfter = 80 } = {}) {
    const props =
      '<w:pPr>' +
      (indent ? `<w:ind w:left="${indent}"/>` : '') +
      `<w:spacing w:before="${spaceBefore}" w:after="${spaceAfter}"/>` +
      '</w:pPr>';
    return `<w:p>${props}${content}</w:p>`;
  }

  const BORDER = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
    .map((s) => `<w:${s} w:val="single" w:sz="4" w:color="BFBFBF"/>`)
    .join('');

  function table(head, body) {
    const cell = (text, bold) =>
      `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr>` +
      `<w:p><w:pPr><w:spacing w:before="40" w:after="40"/></w:pPr>${runs(text, { bold })}</w:p></w:tc>`;
    const rows = [
      `<w:tr>${head.map((c) => cell(c, true)).join('')}</w:tr>`,
      ...body.map((r) => `<w:tr>${r.map((c) => cell(c, false)).join('')}</w:tr>`),
    ].join('');
    return `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders>${BORDER}</w:tblBorders></w:tblPr>${rows}</w:tbl>`;
  }

  const HEADING_SIZE = { 1: 36, 2: 30, 3: 26, 4: 24, 5: 22, 6: 22 };

  function markdownToBody(md) {
    const lines = String(md ?? '').replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let paragraph = [];

    const flush = () => {
      if (paragraph.length) {
        out.push(para(runs(paragraph.join(' '))));
        paragraph = [];
      }
    };

    const isRow = (l) => /^\s*\|.*\|\s*$/.test(l);
    const isDivider = (l) => /^\s*\|[\s:|-]+\|\s*$/.test(l);
    const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) { flush(); continue; }

      if (isRow(line) && i + 1 < lines.length && isDivider(lines[i + 1])) {
        flush();
        const head = cells(line);
        i += 2;
        const body = [];
        while (i < lines.length && isRow(lines[i])) body.push(cells(lines[i++]));
        i--;
        out.push(table(head, body));
        out.push(para(''));   // 表格後留一個空段，否則 Word 會黏在一起
        continue;
      }

      const h = /^(#{1,6})\s+(.*)$/.exec(line);
      if (h) {
        flush();
        const level = h[1].length;
        out.push(para(runs(h[2], { bold: true, size: HEADING_SIZE[level] }), {
          spaceBefore: level <= 2 ? 240 : 160,
          spaceAfter: 120,
        }));
        continue;
      }

      const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
      const numbered = /^(\s*)\d+[.)]\s+(.*)$/.exec(line);
      const item = bullet || numbered;
      if (item) {
        flush();
        const depth = Math.floor(item[1].replace(/\t/g, '  ').length / 2);
        const marker = bullet ? (depth ? '◦ ' : '• ') : `${/^\s*(\d+)/.exec(line)[1]}. `;
        out.push(para(run(marker) + runs(item[2]), { indent: 360 + depth * 360, spaceAfter: 40 }));
        continue;
      }

      if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) { flush(); out.push(para('')); continue; }

      paragraph.push(line.trim());
    }
    flush();
    return out.join('');
  }

  function markdownToDocx(markdown, title) {
    const heading = title
      ? para(runs(title, { bold: true, size: 40 }), { spaceAfter: 240 })
      : '';

    const document =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      `<w:body>${heading}${markdownToBody(markdown)}` +
      '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>' +
      '<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr>' +
      '</w:body></w:document>';

    const files = [
      {
        name: '[Content_Types].xml',
        content:
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
          '</Types>',
      },
      {
        name: '_rels/.rels',
        content:
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
          '</Relationships>',
      },
      { name: 'word/document.xml', content: document },
    ];

    return zip(files);
  }

  root.markdownToDocx = markdownToDocx;
  if (typeof module !== 'undefined' && module.exports) module.exports = { markdownToDocx, zip, crc32 };
})(typeof window !== 'undefined' ? window : globalThis);
