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
- National Cheng Kung University → 國立成功大學
- University of Oxford → 牛津大學
- throughput → 吞吐量
- large language model → 大型語言模型`;

// 12 句長度不一的真實演講句子，輪流使用避免快取效應
const SENTENCES = [
  'Good morning everyone, and welcome to the symposium.',
  'Today I want to talk about how large language models handle throughput at scale.',
  'The key insight here is that latency and throughput are often in tension.',
  'If you look at the chart on the left, you can see a clear downward trend after 2023.',
  'This has significant implications for how we design inference infrastructure.',
  'Let me give you a concrete example from our work at Oxford.',
  'We measured a forty percent reduction in cost per token.',
  'But that number alone does not tell the whole story.',
  'The second experiment used a completely different methodology.',
  'I will come back to this point in the final section of the talk.',
  'Are there any questions before I move on?',
  'Thank you, that is an excellent question and I want to address it carefully.',
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
  let sample = '';
  let failed = 0;

  for (let i = 0; i < RUNS; i++) {
    const sentence = SENTENCES[i % SENTENCES.length];
    const t0 = performance.now();
    try {
      const out = await fn(model, apiKey, sentence);
      times.push(performance.now() - t0);
      if (!sample) sample = out;
      process.stdout.write('.');
    } catch (err) {
      failed++;
      process.stdout.write('x');
      if (failed === 1) sample = '錯誤：' + err.message;
    }
  }

  if (!times.length) {
    console.log(`  全部失敗\n     ${sample}`);
    return null;
  }
  const s = stats(times);
  console.log(
    `  p50 ${s.p50.toFixed(0).padStart(5)}ms   p95 ${s.p95.toFixed(0).padStart(5)}ms   ` +
      `min ${s.min.toFixed(0)}  max ${s.max.toFixed(0)}${failed ? `  (${failed} 次失敗)` : ''}`
  );
  return { label, ...s, sample };
}

// ---- 主程 ----

const gemKey = (process.env.GEMINI_API_KEY || '').trim();
const antKey = (process.env.ANTHROPIC_API_KEY || '').trim();

console.log(`\n即時翻譯延遲量測  ——  每項 ${RUNS} 次，含網路往返\n`);
console.log('（這是「送出英文句子」到「拿到完整中文譯文」的端到端時間）\n');

const results = [];

if (gemKey) {
  for (const m of ['gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-3.7-flash']) {
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

results.sort((a, b) => a.p50 - b.p50);
console.log('\n──────────────────────────────────────────────');
console.log('由快到慢：\n');
for (const r of results) {
  console.log(`  ${r.p50.toFixed(0).padStart(5)}ms  ${r.label}`);
}

const best = results[0];
console.log('\n最快的譯文範例：');
console.log(`  ${best.label}`);
console.log(`  「${best.sample}」`);

console.log('\n延遲預算參考：');
console.log('  Deepgram 判定句子結束      ~300-500ms');
console.log('  翻譯（上面量到的）          ?');
console.log('  SSE 廣播到觀眾手機          ~50-150ms');
console.log('  目標：中文字幕落後語音 1-2 秒');
console.log('  => 翻譯這段的預算大約 500-1200ms\n');
