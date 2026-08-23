// 即時翻譯延遲量測
//
//   node bench.mjs          預設每個供應商跑 10 次
//   node bench.mjs 20       跑 20 次
//
// 讀 .env 裡的 key，對每個有設定的供應商送出「和正式環境一樣大小」的翻譯請求，
// 量測端到端往返時間。因為包含網路延遲，**必須在你實際會用的那台機器、
// 那個網路環境下跑**，數字才有意義（台灣連 Google 和連 Anthropic 的路徑不同）。

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(fileURLToPath(import.meta.url));
const RUNS = Number(process.argv[2]) || 10;

// ---- .env ----
try {
  const raw = await readFile(join(ROOT, '.env'), 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
} catch {
  console.error('讀不到 .env，改用系統環境變數。\n');
}

// 這份提示詞的長度刻意比照 server.mjs 的正式版本（約 650 tokens），
// 因為輸入長度會直接影響 prefill 時間，用短提示詞量會失真。
const SYSTEM = `你是會議即時字幕的英譯中翻譯器。把英文口語翻成「台灣繁體中文」。

輸出規則：
- 只輸出譯文本身。不要引號、不要標籤、不要解釋，也不要「翻譯：」這類前綴。
- 輸入是即時語音辨識的逐句結果，可能句子不完整或有辨識錯誤。依上下文合理推斷語意直接翻，不要加註說明。
- 若該句沒有實質內容（純填充詞、雜訊），輸出空字串。

語言規範（最重要）：
- 一律使用台灣繁體中文與台灣慣用詞彙，絕不可出現中國大陸用語。對照範例：
  軟體（非軟件）、網路（非網絡）、程式（非程序）、資料（非數據）、影片（非視頻）、
  解析度（非分辨率）、演算法（非算法）、伺服器（非服務器）、專案（非項目）、
  品質（非質量）、滑鼠（非鼠標）、印表機（非打印機）、資訊（非信息）、
  預設（非默認）、簡報（非幻燈片）、記憶體（非內存）、硬碟（非硬盤）、
  使用者（非用戶）、介面（非界面）、支援（非支持）、最佳化（非優化）
- 標點一律使用全形：，。、；：？！「」（）
- 語氣口語、自然、簡潔，適合投影在螢幕上快速閱讀，避免冗長書面語。
- 人名、公司名、產品名、專有名詞、程式碼、數學符號、單位一律保留英文原文。
- 講者的填充詞（um、uh、you know、like、I mean、sort of）略去不譯。

會議詞彙表（出現時必須照此處理）：
- Hertford College → 赫特福德學院
- Bodleian Library → 博德利圖書館
- collegiate system → 書院制
- tutorial system → 導生制
- Cowley → 考利
- assembly line → 生產線
- just-in-time → 及時生產
- chiaroscuro → 明暗對照法
- Industrial Revolution → 工業革命
- change management → 變革管理`;

// 刻意挑會考倒模型的句子：
// (1) 語音辨識常見的殘句與口語贅詞  (2) 容易翻成對岸用語的科技詞
// (3) 本次課程的專有名詞            (4) 數字與年份
const SENTENCES = [
  'Good morning everyone, and welcome to Hertford College.',
  'The software and network infrastructure here, the data quality is really quite good.',
  'And so the collegiate system, which is, well, it is quite different from what you might expect.',
  'If you look at the chart, you can see the trend after twenty twenty three.',
  'Um, the tutorial system, you know, it means you meet your tutor once a week.',
  'The Bodleian Library holds over thirteen million printed items.',
  "Now, Britain's economy, after the Industrial Revolution, went through, um, several phases.",
  'At the Cowley plant the assembly line runs on a just-in-time model.',
  'This painting uses chiaroscuro to create a sense of depth and volume.',
  'Change management is really about, I mean, how people respond to uncertainty.',
  'Are there any questions before we break for lunch?',
  'So the key point here, and I want you to remember this, is resilience.',
];

const CONTEXT = 'And that brings me to the second half of the presentation.\nWe now turn to the practical side.';

function buildUser(sentence) {
  return `[前文，僅供理解上下文，不要翻譯]\n${CONTEXT}\n\n[請翻譯這句]\n${sentence}`;
}

// ---- 供應商 ----

async function geminiCall(model, apiKey, sentence) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents: [{ role: 'user', parts: [{ text: buildUser(sentence) }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 1024, thinkingConfig: { thinkingLevel: 'minimal' } },
      }),
      signal: AbortSignal.timeout(30_000),
    }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 120)}`);
  const d = await res.json();
  return (d?.candidates?.[0]?.content?.parts?.[0]?.text ?? '').trim();
}

async function claudeCall(model, apiKey, sentence) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      temperature: 0.3,
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: buildUser(sentence) }],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 120)}`);
  const d = await res.json();
  return (d?.content?.[0]?.text ?? '').trim();
}

// Agent SDK 是選配 —— 沒安裝就跳過，不讓它拖垮整個量測
async function makeAgentSdkRunner() {
  let query;
  try {
    ({ query } = await import('@anthropic-ai/claude-agent-sdk'));
  } catch {
    return null;
  }
  return async (model, _apiKey, sentence) => {
    let out = '';
    for await (const msg of query({
      prompt: `${SYSTEM}\n\n${buildUser(sentence)}`,
      options: { model, maxTurns: 1, allowedTools: [] },
    })) {
      if (msg.type === 'assistant') {
        for (const block of msg.message?.content || []) {
          if (block.type === 'text') out += block.text;
        }
      }
    }
    return out.trim();
  };
}

// ---- 品質檢查 ----
// 速度快但翻出對岸用語就沒意義了，所以順便自動檢查譯文。

// 只在簡體中文出現的字。譯文若含這些字，代表模型根本沒照「繁體」指示走。
//
// 這份清單只收「簡體專有」的字形。刻意排除了正繁體通用的字
// （言、程、理、出、辨、後/后、於/于、內/内 等），否則每句正常譯文都會被誤報。
const SIMPLIFIED = /[软网络数频认务标机盘项质让说学术时间这个们为从门问题实现发开关无与电脑语译单双击点线图样种业员会议课记录处设计统输]/;

// 台灣不會這樣講的技術詞（即使寫成繁體也是對岸用法）
const MAINLAND_TERMS = [
  '軟件', '網絡', '數據', '視頻', '信息', '用戶', '界面', '默認',
  '服務器', '鼠標', '打印機', '內存', '硬盤', '分辨率', '算法', '幻燈片',
];

// 半形標點直接貼著中文字 —— 提示詞要求全形
const HALFWIDTH_PUNCT = /[一-鿿][,.?!;:]|[,.?!;:][一-鿿]/;

function checkQuality(text) {
  const issues = [];
  const simp = text.match(new RegExp(SIMPLIFIED, 'g'));
  if (simp) issues.push(`簡體字(${[...new Set(simp)].join('')})`);
  for (const term of MAINLAND_TERMS) {
    if (text.includes(term)) issues.push(`陸用語(${term})`);
  }
  if (HALFWIDTH_PUNCT.test(text)) issues.push('半形標點');
  // 譯文裡不該出現這些多餘的框架
  if (/^(翻譯|譯文|中文)\s*[:：]/.test(text)) issues.push('多餘前綴');
  if (/^["「『].*["」』]$/.test(text.trim())) issues.push('多餘引號');
  return issues;
}

// ---- 量測 ----

function stats(list) {
  const s = [...list].sort((a, b) => a - b);
  const at = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
  return {
    min: s[0],
    p50: at(0.5),
    p95: at(0.95),
    max: s[s.length - 1],
    avg: s.reduce((a, b) => a + b, 0) / s.length,
  };
}

async function measure(label, fn, model, apiKey) {
  process.stdout.write(`  ${label.padEnd(34)} `);
  const times = [];
  const outputs = [];
  const allIssues = [];
  let failed = 0;
  let firstError = '';

  for (let i = 0; i < RUNS; i++) {
    const sentence = SENTENCES[i % SENTENCES.length];
    const t0 = performance.now();
    try {
      const out = await fn(model, apiKey, sentence);
      times.push(performance.now() - t0);
      outputs.push({ en: sentence, zh: out });
      const issues = checkQuality(out);
      allIssues.push(...issues);
      process.stdout.write(issues.length ? '!' : '.');
    } catch (err) {
      failed++;
      process.stdout.write('x');
      if (!firstError) firstError = err.message;
    }
  }

  if (!times.length) {
    console.log(`  全部失敗\n     ${firstError}`);
    return null;
  }
  const s = stats(times);
  console.log(
    `  p50 ${s.p50.toFixed(0).padStart(5)}ms   p95 ${s.p95.toFixed(0).padStart(5)}ms   ` +
      `品質問題 ${String(allIssues.length).padStart(2)}${failed ? `  (${failed} 次失敗)` : ''}`
  );
  return { label, ...s, outputs, issues: allIssues, failed };
}

// ---- 主程 ----

const gemKey = (process.env.GEMINI_API_KEY || '').trim();
const antKey = (process.env.ANTHROPIC_API_KEY || '').trim();

console.log(`\n即時翻譯延遲量測  ——  每項 ${RUNS} 次，含網路往返\n`);
console.log('（這是「送出英文句子」到「拿到完整中文譯文」的端到端時間）\n');

const results = [];

if (gemKey) {
  for (const m of ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3-flash-preview', 'gemini-3.5-flash']) {
    const r = await measure(`Gemini  ${m}`, geminiCall, m, gemKey);
    if (r) results.push(r);
  }
} else {
  console.log('  (略過 Gemini：未設定 GEMINI_API_KEY)');
}

if (antKey) {
  for (const m of ['claude-haiku-4-5-20251001', 'claude-sonnet-5']) {
    const r = await measure(`Claude API  ${m}`, claudeCall, m, antKey);
    if (r) results.push(r);
  }

  const agent = await makeAgentSdkRunner();
  if (agent) {
    const r = await measure('Claude Agent SDK  haiku-4.5', agent, 'claude-haiku-4-5-20251001', antKey);
    if (r) results.push(r);
  } else {
    console.log('  (略過 Agent SDK：未安裝，npm i @anthropic-ai/claude-agent-sdk 後可一併量測)');
  }
} else {
  console.log('  (略過 Claude：未設定 ANTHROPIC_API_KEY)');
}

if (!results.length) {
  console.log('\n沒有可量測的供應商，請先在 .env 填入至少一把 key。\n');
  process.exit(1);
}

console.log('\n══════════════════════════════════════════════════════════');
console.log('速度排名（p50，含網路往返）\n');
for (const r of [...results].sort((a, b) => a.p50 - b.p50)) {
  const bar = '█'.repeat(Math.min(40, Math.round(r.p50 / 40)));
  console.log(`  ${r.p50.toFixed(0).padStart(5)}ms  ${bar}  ${r.label}`);
}

console.log('\n══════════════════════════════════════════════════════════');
console.log('台灣繁中品質（問題越少越好）\n');
for (const r of [...results].sort((a, b) => a.issues.length - b.issues.length)) {
  const counts = {};
  for (const i of r.issues) {
    const kind = i.replace(/\(.*\)/, '');
    counts[kind] = (counts[kind] || 0) + 1;
  }
  const detail = Object.entries(counts).map(([k, v]) => `${k}x${v}`).join('  ');
  console.log(`  ${String(r.issues.length).padStart(2)} 個問題  ${r.label.padEnd(34)} ${detail || '乾淨'}`);
}

console.log('\n══════════════════════════════════════════════════════════');
console.log('同一句話，各家怎麼翻（自己看語感）\n');
for (let i = 0; i < Math.min(3, SENTENCES.length); i++) {
  console.log(`  EN  ${SENTENCES[i]}`);
  for (const r of results) {
    const hit = r.outputs.find((o) => o.en === SENTENCES[i]);
    if (hit) console.log(`      ${r.label.padEnd(34)} ${hit.zh}`);
  }
  console.log('');
}

console.log('══════════════════════════════════════════════════════════');
console.log('延遲預算參考：\n');
console.log('  Deepgram 判定句子結束      ~300-500ms   （已設 endpointing=300）');
console.log('  翻譯                        ← 上面量到的');
console.log('  SSE 廣播到觀眾手機          ~50-150ms');
console.log('  ────────────────────────────────────────');
console.log('  目標：中文落後語音 1-2 秒  =>  翻譯預算約 500-1200ms\n');
console.log('決定方式：先看有沒有落在預算內，再從落在預算內的裡面挑品質最好的。\n');
