// 極簡 Markdown 渲染器
//
// 只處理課程筆記實際會用到的語法子集：標題、粗體、行內程式碼、
// 巢狀項目符號、編號清單、表格。刻意不引入外部套件，維持整個專案零相依。
//
// 安全性：所有內容一律先跳脫 HTML 再套格式。筆記由模型產生、
// 逐字稿來自語音辨識，兩者都不該被當成可信的 HTML。

(function () {
  'use strict';

  const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ESCAPES[c]);

  // 行內格式。順序有意義：粗體要在斜體之前，否則 ** 會被拆成兩個 *
  function inline(text) {
    return escapeHtml(text)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  }

  const isTableRow = (line) => /^\s*\|.*\|\s*$/.test(line);
  const isTableDivider = (line) => /^\s*\|[\s:|-]+\|\s*$/.test(line);
  const splitRow = (line) =>
    line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

  function renderMarkdown(md) {
    const lines = String(md ?? '').replace(/\r\n?/g, '\n').split('\n');
    const out = [];

    // 用堆疊記錄目前開著的清單，才能處理巢狀項目
    let listStack = [];   // [{ tag, indent }]
    let paragraph = [];

    function closeParagraph() {
      if (paragraph.length) {
        out.push(`<p>${inline(paragraph.join(' '))}</p>`);
        paragraph = [];
      }
    }
    function closeLists(toIndent = -1) {
      while (listStack.length && listStack[listStack.length - 1].indent > toIndent) {
        out.push(`</${listStack.pop().tag}>`);
      }
    }
    function closeAll() {
      closeParagraph();
      closeLists();
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // 空行：段落與清單都結束
      if (!line.trim()) {
        closeAll();
        continue;
      }

      // 表格：目前行是 |...| 且下一行是分隔列
      if (isTableRow(line) && i + 1 < lines.length && isTableDivider(lines[i + 1])) {
        closeAll();
        const head = splitRow(line);
        i += 2;
        const body = [];
        while (i < lines.length && isTableRow(lines[i])) body.push(splitRow(lines[i++]));
        i--;
        out.push(
          '<table><thead><tr>' +
            head.map((c) => `<th>${inline(c)}</th>`).join('') +
            '</tr></thead><tbody>' +
            body
              .map((r) => '<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>')
              .join('') +
            '</tbody></table>'
        );
        continue;
      }

      // 標題
      const heading = /^(#{1,6})\s+(.*)$/.exec(line);
      if (heading) {
        closeAll();
        const level = Math.min(6, heading[1].length);
        out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
        continue;
      }

      // 水平線
      if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
        closeAll();
        out.push('<hr>');
        continue;
      }

      // 清單項目（含巢狀）
      const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
      const numbered = /^(\s*)\d+[.)]\s+(.*)$/.exec(line);
      const item = bullet || numbered;
      if (item) {
        closeParagraph();
        const indent = item[1].replace(/\t/g, '  ').length;
        const tag = bullet ? 'ul' : 'ol';

        closeLists(indent);
        const top = listStack[listStack.length - 1];
        if (!top || top.indent < indent) {
          listStack.push({ tag, indent });
          out.push(`<${tag}>`);
        } else if (top.tag !== tag) {
          out.push(`</${listStack.pop().tag}>`);
          listStack.push({ tag, indent });
          out.push(`<${tag}>`);
        }
        out.push(`<li>${inline(item[2])}</li>`);
        continue;
      }

      // 其餘視為段落內容
      closeLists();
      paragraph.push(line.trim());
    }

    closeAll();
    return out.join('\n');
  }

  window.renderMarkdown = renderMarkdown;
})();
