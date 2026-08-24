// 費用估算
//
//   node estimate-cost.mjs                預設：5 天、每天 4 小時講課
//   node estimate-cost.mjs 5 6            5 天、每天 6 小時
//
// 提示詞長度是從 server.mjs 和 glossary.json 實際讀出來算的，不是猜的。
//
// 重點：學生人數「不會」影響翻譯費用。翻譯在伺服器上做一次，
// 再廣播給所有人 —— 20 人跟 1 人的翻譯成本完全相同。

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DAYS = Number(process.argv[2]) || 5;
const HOURS_PER_DAY = Number(process.argv[3]) || 4;

// 官方報價（USD / 百萬 token）
const PRICES = {
  'claude-haiku-4-5': { in: 1, out: 5, cacheRead: 0.10, cacheWrite: 1.25 },
  'claude-sonnet-5': { in: 2, out: 10, cacheRead: 0.20, cacheWrite: 2.50 },
  'claude-opus-5': { in: 5, out: 25, cacheRead: 0.50, cacheWrite: 6.25 },
  // Gemini 官方價目表（付費層）。3.7-flash 的 $0.75/$3.75 是 2026 年底前的優惠價，
  // 2027/1/1 起漲為 $1.50/$7.50。
  'gemini-3.1-flash-lite': { in: 0.25, out: 1.50, cacheRead: null },
  'gemini-3.7-flash': { in: 0.75, out: 3.75, cacheRead: null },
  'gemini-3.5-flash': { in: 1.50, out: 9.00, cacheRead: null },
};

// 粗略但夠用的估算：中日韓字約 1 字 1 token，其餘約 4 字元 1 token
function countTokens(text) {
  const cjk = (text.match(/[　-鿿＀-￯]/g) || []).length;
  const rest = text.length - cjk;
  return Math.round(cjk + rest / 4);
}

// ---- 從實際檔案讀出提示詞 ----

const serverSrc = await readFile(join(ROOT, 'server.mjs'), 'utf8');
const grab = (name) => {
  const m = new RegExp(`const ${name} = \`([\\s\\S]*?)\`;`).exec(serverSrc);
  if (!m) throw new Error(`在 server.mjs 找不到 ${name}`);
  return m[1];
};
const translatePrompt = grab('TAIWAN_SYSTEM_PROMPT');
const notesPrompt = grab('NOTES_SYSTEM_PROMPT');

const glossary = JSON.parse(await readFile(join(ROOT, 'glossary.json'), 'utf8'));
const terms = glossary.terms.filter((t) => t.en);
const glossaryBlock =
  '\n\n會議詞彙表（出現時必須照此處理）：\n' +
  terms.map((t) => `- ${t.en} → ${t.zh || '（保留英文原文）'}`).join('\n');

const SYS_TOKENS = countTokens(translatePrompt + glossaryBlock);
const NOTES_SYS_TOKENS = countTokens(notesPrompt);

// ---- 用量假設 ----

const WPM = 130;                    // 一般演講語速
const WORDS_PER_SEGMENT = 18;       // endpointing 800ms 下的平均句長
const CONTEXT_TOKENS = 60;          // 帶入的前 2 句
const OUT_TOKENS = 40;              // 一句中文譯文
const TOKENS_PER_EN_WORD = 1.3;

const segPerMin = WPM / WORDS_PER_SEGMENT;
const totalMinutes = DAYS * HOURS_PER_DAY * 60;
const requests = Math.round(segPerMin * totalMinutes);
const inPerReq = Math.round(WORDS_PER_SEGMENT * TOKENS_PER_EN_WORD) + CONTEXT_TOKENS;

console.log(`\n${'='.repeat(62)}`);
console.log(`  費用估算  ${DAYS} 天 × 每天 ${HOURS_PER_DAY} 小時講課`);
console.log('='.repeat(62));

console.log('\n【實測的提示詞長度】（從程式碼算出，非估計）');
console.log(`  翻譯系統提示詞    ${countTokens(translatePrompt).toLocaleString()} tokens`);
console.log(`  詞彙表（${terms.length} 詞）    ${countTokens(glossaryBlock).toLocaleString()} tokens`);
console.log(`  合計每次固定送出  ${SYS_TOKENS.toLocaleString()} tokens  <- 每句都重送，所以快取很關鍵`);

console.log('\n【用量推算】');
console.log(`  語速              ${WPM} 字/分，平均每句 ${WORDS_PER_SEGMENT} 字`);
console.log(`  每分鐘句數        ${segPerMin.toFixed(1)}`);
console.log(`  總講課時間        ${(totalMinutes / 60).toFixed(0)} 小時`);
console.log(`  翻譯總請求數      ${requests.toLocaleString()} 次`);

// ---- 翻譯費用 ----

console.log('\n【即時翻譯費用】');
console.log('  ※ 學生人數不影響此項 —— 翻譯做一次，廣播給所有人\n');

const rows = [];
for (const [model, p] of Object.entries(PRICES)) {
  const outTok = (requests * OUT_TOKENS) / 1e6;
  const freshTok = (requests * inPerReq) / 1e6;
  const sysTok = (requests * SYS_TOKENS) / 1e6;

  const noCache = (sysTok + freshTok) * p.in + outTok * p.out;

  let cached = null;
  if (p.cacheRead != null) {
    // 每節課寫一次快取，其餘都是讀取（5 分鐘 TTL，講課時請求密集不會過期）
    const writes = DAYS * 3;
    const writeCost = (writes * SYS_TOKENS / 1e6) * p.cacheWrite;
    cached = writeCost + sysTok * p.cacheRead + freshTok * p.in + outTok * p.out;
  }
  rows.push({ model, noCache, cached });
}

console.log('  模型                        無快取      啟用快取');
console.log('  ' + '-'.repeat(56));
for (const r of rows) {
  const c = r.cached == null ? '  不適用' : `US$${r.cached.toFixed(2)}`.padStart(9);
  console.log(`  ${r.model.padEnd(26)} ${('US$' + r.noCache.toFixed(2)).padStart(9)}  ${c}`);
}

// ---- 筆記費用 ----

const sentencesPerDay = Math.round(segPerMin * HOURS_PER_DAY * 60);
const transcriptTokens = sentencesPerDay * (inPerReq + OUT_TOKENS);
const GENERATIONS_PER_DAY = 3;   // 有快取，全班同時按只算一次

console.log('\n【一鍵整理筆記費用】');
console.log(`  每天逐字稿約      ${sentencesPerDay.toLocaleString()} 句 ≈ ${(transcriptTokens / 1000).toFixed(0)}k tokens`);
console.log(`  每天產生次數      ${GENERATIONS_PER_DAY} 次（伺服器有快取，全班同時按只算一次）`);
console.log(`  總產生次數        ${GENERATIONS_PER_DAY * DAYS} 次\n`);

const notesRuns = GENERATIONS_PER_DAY * DAYS;
const notesOut = 3000;
for (const [model, p] of Object.entries(PRICES)) {
  const cost =
    (notesRuns * (transcriptTokens + NOTES_SYS_TOKENS) / 1e6) * p.in +
    (notesRuns * notesOut / 1e6) * p.out;
  console.log(`  ${model.padEnd(26)} ${('US$' + cost.toFixed(2)).padStart(9)}`);
}

// ---- 總計 ----

const lite = rows.find((r) => r.model === 'gemini-3.1-flash-lite');
const pNotes = PRICES['gemini-3.7-flash'];
const notesCost =
  (notesRuns * (transcriptTokens + NOTES_SYS_TOKENS) / 1e6) * pNotes.in +
  (notesRuns * notesOut / 1e6) * pNotes.out;

console.log('\n' + '='.repeat(62));
console.log('  建議組合總計（全部用同一把 Gemini key）');
console.log('='.repeat(62));
console.log('  語音辨識  Google Web Speech          US$0.00   （瀏覽器內建，免費）');
console.log(`  即時翻譯  gemini-3.1-flash-lite      US$${lite.noCache.toFixed(2)}`);
console.log(`  整理筆記  gemini-3.7-flash           US$${notesCost.toFixed(2)}`);
console.log('  伺服器    Render 免費方案            US$0.00');
console.log('  ' + '-'.repeat(58));
const total = lite.noCache + notesCost;
console.log(`  合計                                 US$${total.toFixed(2)}   （約 NT$${Math.round(total * 32)}）\n`);
console.log('  註：以上為估算。實際 token 數依講者語速、口音、內容而異，');
console.log('      抓 1.5 倍當上限比較保險。\n');
