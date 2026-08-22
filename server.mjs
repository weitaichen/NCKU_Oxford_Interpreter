// 會議即時英譯中字幕系統 — Relay 伺服器
//
// 架構（相對於規劃文件第 4 節有兩處刻意調整，理由見 README）：
//   Captioner ──① 索取 Deepgram 短期 token
//             ──② 直連 Deepgram WSS 送音訊、收英文逐句
//             ──③ 逐句 POST 純文字到本伺服器
//   Relay     ──④ 呼叫翻譯模型（Gemini 或 Claude）翻成台灣繁中
//             ──⑤ 以 SSE 廣播給所有觀眾，同時存檔逐字稿
//   Viewer    ──⑥ EventSource 接收（瀏覽器原生自動重連）
//
// 零外部相依，node server.mjs 就能跑。API key 只留在本行程內，不會送到瀏覽器。

import { createServer } from 'node:http';
import { readFile, appendFile, mkdir, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { networkInterfaces } from 'node:os';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(ROOT, 'public');
const TRANSCRIPT_DIR = join(ROOT, 'transcripts');

const BACKLOG_SIZE = 40;   // 中途加入的觀眾能補看幾句
const CONTEXT_SIZE = 2;    // 餵給翻譯模型的前文句數

// ---------------------------------------------------------------- 設定載入

async function loadEnvFile(path) {
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return;
  }
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(m[1] in process.env)) process.env[m[1]] = value;
  }
}

// 去掉易混淆的 I/O/0/1，房間碼要用嘴巴念給現場觀眾聽
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function makeCode(length) {
  return Array.from(randomBytes(length), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

// ------------------------------------------------------------ 翻譯服務商

const TAIWAN_SYSTEM_PROMPT = `你是會議即時字幕的英譯中翻譯器。把英文口語翻成「台灣繁體中文」。

輸出規則：
- 只輸出譯文本身。不要引號、不要標籤、不要解釋，也不要「翻譯：」這類前綴。
- 輸入是即時語音辨識的逐句結果，可能句子不完整或有辨識錯誤。依上下文合理推斷語意直接翻，不要加註「（原文不完整）」之類的說明。
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
- 講者的填充詞（um、uh、you know、like、I mean、sort of）略去不譯。`;

// 「思考」設定在不同世代的 Gemini 之間換過欄位名。字幕要的是速度，
// 所以先送最低思考層級；萬一該模型不吃這個欄位，就拿掉重送一次，
// 不要讓一個選用參數把整場字幕搞掛。
let geminiThinking = { thinkingLevel: 'minimal' };

async function callGemini({ apiKey, model, system, user, signal, maxTokens = 1024, thinking = geminiThinking }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

  const send = (thinkingCfg) =>
    fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: maxTokens,
          ...(thinkingCfg ? { thinkingConfig: thinkingCfg } : {}),
        },
      }),
      signal,
    });

  let res = await send(geminiThinking);

  if (res.status === 400 && geminiThinking) {
    const detail = await res.text().catch(() => '');
    if (/thinking/i.test(detail)) {
      console.warn('[gemini] 此模型不支援 thinkingConfig，之後一律省略該欄位。');
      geminiThinking = null;
      res = await send(null);
    } else {
      throw Object.assign(new Error(detail.slice(0, 400)), { status: 400 });
    }
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw Object.assign(new Error(detail.slice(0, 400)), { status: res.status });
  }
  const data = await res.json();
  return (data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '').trim();
}

async function callClaude({ apiKey, model, system, user, signal, maxTokens = 1024 }) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      temperature: 0.3,
      // 系統提示詞每句都重送，快取起來可省下約 9 成的輸入成本
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: user }],
    }),
    signal,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw Object.assign(new Error(detail.slice(0, 400)), { status: res.status });
  }
  const data = await res.json();
  return (data?.content?.[0]?.text ?? '').trim();
}

const PROVIDERS = {
  gemini: {
    keyEnv: 'GEMINI_API_KEY',
    defaultModel: 'gemini-3.7-flash',
    defaultSummaryModel: 'gemini-3.7-flash',
    call: callGemini,
  },
  claude: {
    keyEnv: 'ANTHROPIC_API_KEY',
    defaultModel: 'claude-haiku-4-5-20251001',
    defaultSummaryModel: 'claude-sonnet-5',
    call: callClaude,
  },
};

// 整理筆記跟即時翻譯是完全不同的工作：一次呼叫、不趕時間、要的是理解與結構。
// 所以用比較強的模型，成本一次約 US$0.02，可以忽略。
const NOTES_SYSTEM_PROMPT = `你是專業的學術會議記錄整理者。使用者會給你一場演講／會議的「中英對照逐字稿」，請整理成一份結構清晰、可直接拿來複習的台灣繁體中文筆記。

用 Markdown 輸出，依序包含這些段落：

## 一句話總結
整場的核心主張，兩三句話講完。

## 重點大綱
分層條列，涵蓋主要論點與推進脈絡。每個重點下面可以帶一兩句支撐說明。

## 關鍵術語
表格三欄：英文原文 ｜ 中文 ｜ 一句話解釋。只收錄真正重要的，不要湊數。

## 值得追問的問題
三到五個聽完後值得深入或查證的問題。

## 需要回頭確認的段落
逐字稿來自即時語音辨識，難免有錯。把你判斷可能辨識錯誤、或語意明顯不通的地方標出來，附上原文位置，讓人回頭聽錄音確認。沒有的話就寫「無」。

規則：
- 一律使用台灣繁體中文與台灣慣用詞彙，標點全形。
- 人名、機構名、產品名、專有名詞保留英文原文，必要時在後面補中文。
- **忠實於逐字稿**，不要補充原文沒有講到的內容。你不確定的地方寧可放進「需要回頭確認」，也不要自己編。
- 逐字稿可能有斷句錯誤或錯字，請依上下文合理推斷語意，不要照抄明顯的辨識錯誤。`;

// ------------------------------------------------------------------ 狀態

const state = {
  seq: 0,
  backlog: [],          // 最近的字幕，給中途加入的觀眾補看
  transcript: [],       // 本次行程的完整逐字稿（Render 免費方案沒有持久磁碟，檔案不可靠）
  viewers: new Set(),   // 目前的 SSE 連線
  live: false,          // 操作員是否正在收音
  glossary: [],
  recent: [],           // 給翻譯當上下文的最近幾句英文
  startedAt: new Date().toISOString(),
};

function broadcast(event, payload) {
  // 只有「翻譯已完成」的字幕才給 id。半成品（pending）若推進了 Last-Event-ID，
  // 觀眾斷線重連時該句就不會被補送，畫面會永遠卡在「翻譯中」。
  const idLine = payload.pending === true ? '' : `id: ${payload.seq ?? state.seq}\n`;
  const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n${idLine}\n`;
  for (const res of state.viewers) {
    try {
      res.write(frame);
    } catch {
      state.viewers.delete(res);
    }
  }
}

async function archive(entry) {
  try {
    await mkdir(TRANSCRIPT_DIR, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    await appendFile(join(TRANSCRIPT_DIR, `${day}.jsonl`), JSON.stringify(entry) + '\n', 'utf8');
  } catch (err) {
    console.error('[archive] 寫入失敗：', err.message);
  }
}

// -------------------------------------------------------------- HTTP 工具

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = 128 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

async function serveStatic(res, filename) {
  const safe = basename(filename);   // basename 擋掉路徑穿越
  try {
    const buf = await readFile(join(PUBLIC_DIR, safe));
    res.writeHead(200, {
      'content-type': MIME[safe.slice(safe.lastIndexOf('.'))] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(buf);
  } catch {
    sendJson(res, 404, { error: 'not found' });
  }
}

function localAddresses() {
  const out = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out.length ? out : ['localhost'];
}

// ------------------------------------------------------------------- 主程

async function main() {
  await loadEnvFile(join(ROOT, '.env'));

  const deepgramKey = (process.env.DEEPGRAM_API_KEY || '').trim();
  const sttLanguage = (process.env.STT_LANGUAGE || 'en-GB').trim();
  const sttModel = (process.env.STT_MODEL || 'nova-3').trim();

  // 選翻譯服務商：環境變數明確指定優先，否則挑第一個有 key 的
  let providerName = (process.env.TRANSLATE_PROVIDER || '').trim().toLowerCase();
  if (!PROVIDERS[providerName]) {
    providerName =
      Object.keys(PROVIDERS).find((p) => (process.env[PROVIDERS[p].keyEnv] || '').trim()) || 'gemini';
  }
  const provider = PROVIDERS[providerName];
  const translateKey = (process.env[provider.keyEnv] || '').trim();
  const translateModel = (process.env.TRANSLATE_MODEL || '').trim() || provider.defaultModel;

  // 整理筆記可以用跟即時翻譯不同的供應商 —— 一天只呼叫一次，值得用好一點的模型。
  // 沒指定的話優先挑 Claude（筆記品質較好），否則沿用翻譯那家。
  let summaryProviderName = (process.env.SUMMARY_PROVIDER || '').trim().toLowerCase();
  if (!PROVIDERS[summaryProviderName]) {
    summaryProviderName = (process.env.ANTHROPIC_API_KEY || '').trim() ? 'claude' : providerName;
  }
  const summaryProvider = PROVIDERS[summaryProviderName];
  const summaryKey = (process.env[summaryProvider.keyEnv] || '').trim();
  const summaryModel = (process.env.SUMMARY_MODEL || '').trim() || summaryProvider.defaultSummaryModel;

  const roomCode = (process.env.ROOM_CODE || '').trim() || makeCode(4);
  const operatorKey = (process.env.OPERATOR_KEY || '').trim() || makeCode(8);
  const port = Number(process.env.PORT) || 8787;

  // 詞彙表：讓 7 天下來同一個專有名詞都翻得一致
  try {
    const raw = JSON.parse(await readFile(join(ROOT, 'glossary.json'), 'utf8'));
    state.glossary = Array.isArray(raw.terms) ? raw.terms : [];
  } catch {
    state.glossary = [];
  }

  const glossaryBlock = state.glossary.length
    ? '\n\n會議詞彙表（出現時必須照此處理）：\n' +
      state.glossary.map((t) => `- ${t.en} → ${t.zh || '（保留英文原文）'}`).join('\n')
    : '';

  async function translate(english) {
    const contextLines = state.recent.slice(-CONTEXT_SIZE);
    const userMessage =
      (contextLines.length ? `[前文，僅供理解上下文，不要翻譯]\n${contextLines.join('\n')}\n\n` : '') +
      `[請翻譯這句]\n${english}`;

    let lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await provider.call({
          apiKey: translateKey,
          model: translateModel,
          system: TAIWAN_SYSTEM_PROMPT + glossaryBlock,
          user: userMessage,
          signal: AbortSignal.timeout(20_000),
        });
      } catch (err) {
        lastError = err;
        const retryable = !err.status || err.status === 429 || err.status >= 500;
        if (!retryable || attempt === 2) break;
        await new Promise((r) => setTimeout(r, 300 * 2 ** attempt));
      }
    }
    throw lastError;
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const path = url.pathname;

    // ---- 頁面 ----
    if (req.method === 'GET' && (path === '/' || path === '/viewer')) return serveStatic(res, 'viewer.html');
    if (req.method === 'GET' && path === '/captioner') return serveStatic(res, 'captioner.html');
    // sw.js 必須從根路徑供應，否則 Service Worker 的 scope 只涵蓋 /static/，管不到觀眾頁
    if (req.method === 'GET' && path === '/sw.js') return serveStatic(res, 'sw.js');
    if (req.method === 'GET' && path.startsWith('/static/')) return serveStatic(res, path.slice(8));

    // ---- 健康檢查 ----
    // Render 用這支確認服務活著。活動當天也可以先打這支把免費方案叫醒。
    if (req.method === 'GET' && (path === '/healthz' || path === '/health')) {
      return sendJson(res, 200, {
        ok: true,
        live: state.live,
        viewers: state.viewers.size,
        captions: state.transcript.length,
        startedAt: state.startedAt,
      });
    }

    // ---- 公開設定 ----
    if (req.method === 'GET' && path === '/api/config') {
      return sendJson(res, 200, {
        sttReady: Boolean(deepgramKey),
        translateReady: Boolean(translateKey),
        provider: providerName,
        model: translateModel,
        sttLanguage,
        live: state.live,
        viewers: state.viewers.size,
        glossaryTerms: state.glossary.length,
      });
    }

    // ---- 操作員：索取 Deepgram 短期 token ----
    if (req.method === 'POST' && path === '/api/stt-token') {
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return sendJson(res, 400, { error: '無法解析請求內容' });
      }
      if (body.operatorKey !== operatorKey) return sendJson(res, 403, { error: '操作員金鑰錯誤' });
      if (!deepgramKey) {
        return sendJson(res, 503, { error: '尚未設定 DEEPGRAM_API_KEY，請改用 Web Speech 備援模式' });
      }
      try {
        const grant = await fetch('https://api.deepgram.com/v1/auth/grant', {
          method: 'POST',
          headers: { authorization: `Token ${deepgramKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ ttl_seconds: 300 }),
          signal: AbortSignal.timeout(15_000),
        });
        if (!grant.ok) {
          const detail = await grant.text().catch(() => '');
          return sendJson(res, grant.status, {
            error:
              grant.status === 401
                ? 'Deepgram API key 無效'
                : `Deepgram 發放 token 失敗（HTTP ${grant.status}）：${detail.slice(0, 200)}`,
          });
        }
        const data = await grant.json();
        return sendJson(res, 200, {
          accessToken: data.access_token,
          expiresIn: data.expires_in,
          language: sttLanguage,
          model: sttModel,
          keyterms: state.glossary.map((t) => t.en).filter(Boolean).slice(0, 100),
        });
      } catch (err) {
        return sendJson(res, 502, { error: `連不上 Deepgram：${err.message}` });
      }
    }

    // ---- 操作員：送出一句英文，翻譯後廣播 ----
    if (req.method === 'POST' && path === '/api/caption') {
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return sendJson(res, 400, { error: '無法解析請求內容' });
      }
      if (body.operatorKey !== operatorKey) return sendJson(res, 403, { error: '操作員金鑰錯誤' });

      const english = String(body.en ?? '').trim();
      if (!english) return sendJson(res, 400, { error: '沒有內容' });

      const seq = ++state.seq;
      const entry = { seq, t: new Date().toISOString(), en: english, zh: '' };

      // 英文先廣播 —— 規劃文件第 10 節的「英文即時先出、中文緊接著補上」
      broadcast('caption', { ...entry, pending: true });

      if (!translateKey) {
        entry.error = '未設定翻譯 API key';
      } else {
        try {
          entry.zh = await translate(english);
        } catch (err) {
          entry.error = err.status === 401 ? '翻譯 API key 無效' : `翻譯失敗：${err.message.slice(0, 160)}`;
          console.error('[translate]', entry.error);
        }
      }

      state.recent.push(english);
      if (state.recent.length > 10) state.recent.shift();
      state.backlog.push(entry);
      if (state.backlog.length > BACKLOG_SIZE) state.backlog.shift();
      state.transcript.push(entry);

      broadcast('caption', { ...entry, pending: false });
      archive(entry);

      return sendJson(res, 200, { seq, zh: entry.zh, error: entry.error ?? null });
    }

    // ---- 操作員：更新收音狀態 ----
    if (req.method === 'POST' && path === '/api/status') {
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return sendJson(res, 400, { error: '無法解析請求內容' });
      }
      if (body.operatorKey !== operatorKey) return sendJson(res, 403, { error: '操作員金鑰錯誤' });
      state.live = Boolean(body.live);
      broadcast('status', { live: state.live, seq: state.seq });
      return sendJson(res, 200, { live: state.live, viewers: state.viewers.size });
    }

    // ---- 觀眾：驗證房間碼（不佔用 SSE 連線）----
    if (req.method === 'GET' && path === '/api/join') {
      return url.searchParams.get('room') === roomCode
        ? sendJson(res, 200, { ok: true, live: state.live })
        : sendJson(res, 403, { error: '房間碼錯誤' });
    }

    // ---- 觀眾：SSE 訂閱 ----
    if (req.method === 'GET' && path === '/api/stream') {
      if (url.searchParams.get('room') !== roomCode) return sendJson(res, 403, { error: '房間碼錯誤' });

      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write('retry: 2000\n\n');

      // 中途加入或斷線重連的觀眾，補送還沒看到的字幕
      const since = Number(req.headers['last-event-id'] || url.searchParams.get('since') || 0);
      for (const entry of state.backlog) {
        if (entry.seq > since) {
          res.write(
            `event: caption\ndata: ${JSON.stringify({ ...entry, pending: false })}\nid: ${entry.seq}\n\n`
          );
        }
      }
      res.write(`event: status\ndata: ${JSON.stringify({ live: state.live, seq: state.seq })}\n\n`);

      state.viewers.add(res);
      broadcast('viewers', { count: state.viewers.size, seq: state.seq });

      // 註解行心跳，避免中間層把閒置連線切掉
      const heartbeat = setInterval(() => {
        try {
          res.write(': ping\n\n');
        } catch {
          clearInterval(heartbeat);
        }
      }, 15_000);

      req.on('close', () => {
        clearInterval(heartbeat);
        state.viewers.delete(res);
        broadcast('viewers', { count: state.viewers.size, seq: state.seq });
      });
      return;
    }

    // ---- 逐字稿 ----
    if (req.method === 'GET' && path === '/api/transcript') {
      if (url.searchParams.get('key') !== operatorKey) return sendJson(res, 403, { error: '操作員金鑰錯誤' });
      const today = new Date().toISOString().slice(0, 10);
      const day = basename(url.searchParams.get('day') || today);

      // 檔案優先（本機或有掛磁碟時最完整），讀不到就退回記憶體。
      // Render 免費方案的磁碟是暫時性的，重啟就沒了 —— 真正可靠的那份在收音頁的瀏覽器裡。
      let rows = null;
      try {
        const raw = await readFile(join(TRANSCRIPT_DIR, `${day}.jsonl`), 'utf8');
        rows = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
      } catch {
        if (day === today) rows = state.transcript;
      }
      if (!rows || !rows.length) return sendJson(res, 404, { error: `找不到 ${day} 的逐字稿` });

      if (url.searchParams.get('format') === 'txt') {
        res.writeHead(200, {
          'content-type': 'text/plain; charset=utf-8',
          'content-disposition': `attachment; filename="transcript-${day}.txt"`,
        });
        return res.end(rows.map((r) => `${r.en}\n${r.zh}`).join('\n\n'));
      }
      return sendJson(res, 200, { day, count: rows.length, rows });
    }

    // ---- 一鍵整理上課筆記 ----
    if (req.method === 'POST' && path === '/api/summarize') {
      let body;
      try {
        body = JSON.parse(await readBody(req, 8 * 1024 * 1024));
      } catch {
        return sendJson(res, 400, { error: '無法解析請求內容（逐字稿可能過大）' });
      }
      if (body.operatorKey !== operatorKey) return sendJson(res, 403, { error: '操作員金鑰錯誤' });
      if (!summaryKey) {
        return sendJson(res, 503, {
          error: `尚未設定 ${summaryProvider.keyEnv}，無法整理筆記`,
        });
      }

      const rows = Array.isArray(body.rows) ? body.rows : state.transcript;
      if (!rows.length) return sendJson(res, 400, { error: '沒有逐字稿可以整理' });

      let text = rows.map((r) => `${r.en}\n${r.zh || ''}`).join('\n\n');
      let truncated = false;
      const LIMIT = 400_000;   // 約 13 萬 token，留足空間給輸出
      if (text.length > LIMIT) {
        text = text.slice(0, LIMIT);
        truncated = true;
      }

      const title = String(body.title || '').trim();
      const userMessage =
        (title ? `場次：${title}\n\n` : '') +
        `以下是中英對照逐字稿，每組兩行（第一行英文原文、第二行中文翻譯）：\n\n${text}` +
        (truncated ? '\n\n（註：逐字稿過長已截斷，以上為前半部分）' : '');

      try {
        const notes = await summaryProvider.call({
          apiKey: summaryKey,
          model: summaryModel,
          system: NOTES_SYSTEM_PROMPT,
          user: userMessage,
          maxTokens: 8192,
          thinking: null,        // 整理筆記讓模型好好想，不要壓思考
          signal: AbortSignal.timeout(300_000),
        });
        return sendJson(res, 200, {
          notes,
          sentences: rows.length,
          truncated,
          model: summaryModel,
          provider: summaryProviderName,
        });
      } catch (err) {
        console.error('[summarize]', err.message);
        return sendJson(res, err.status || 502, {
          error: err.status === 401 ? `${summaryProvider.keyEnv} 無效` : `整理失敗：${err.message.slice(0, 300)}`,
        });
      }
    }

    if (req.method === 'GET' && path === '/api/transcript/days') {
      if (url.searchParams.get('key') !== operatorKey) return sendJson(res, 403, { error: '操作員金鑰錯誤' });
      try {
        const files = await readdir(TRANSCRIPT_DIR);
        return sendJson(res, 200, {
          days: files.filter((f) => f.endsWith('.jsonl')).map((f) => f.replace('.jsonl', '')).sort(),
        });
      } catch {
        return sendJson(res, 200, { days: [] });
      }
    }

    sendJson(res, 404, { error: 'not found' });
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n連接埠 ${port} 已被占用。換一個：  set PORT=8788 && node server.mjs\n`);
      process.exit(1);
    }
    throw err;
  });

  // Render 會注入這個變數；有它就代表跑在雲端而不是本機
  const externalUrl = (process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');

  server.listen(port, '0.0.0.0', () => {
    console.log('\n  === 會議即時英譯中字幕系統 ===\n');
    console.log(`  STT      ${deepgramKey ? `Deepgram ${sttModel} / ${sttLanguage}` : '未設定 -> 操作頁會退回 Web Speech 備援'}`);
    console.log(`  翻譯     ${translateKey ? `${providerName} / ${translateModel}` : '未設定 -> 字幕只會有英文'}`);
    console.log(`  整理筆記 ${summaryKey ? `${summaryProviderName} / ${summaryModel}` : '未設定'}`);
    console.log(`  詞彙表   ${state.glossary.length} 個詞\n`);

    if (externalUrl) {
      console.log(`  操作員   ${externalUrl}/captioner`);
      console.log(`  觀眾     ${externalUrl}/?room=${roomCode}`);
      console.log('\n  注意：雲端磁碟是暫時性的，重啟後 transcripts/ 會消失。');
      console.log('        可靠的逐字稿在收音頁瀏覽器裡，記得每天散會後按「下載逐字稿」。');
    } else {
      console.log(`  操作員   http://localhost:${port}/captioner`);
      for (const ip of localAddresses()) {
        console.log(`  觀眾     http://${ip}:${port}/?room=${roomCode}`);
      }
    }

    console.log(`\n  房間碼   ${roomCode}      (給觀眾)`);
    console.log(`  操作金鑰 ${operatorKey}  (只給你自己)\n`);

    if (!externalUrl && !process.argv.includes('--no-open') && process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '""', `http://localhost:${port}/captioner`], {
        detached: true,
        stdio: 'ignore',
      }).unref();
    }
  });

  // Render 部署或重啟時會送 SIGTERM。主動關掉 SSE 連線，
  // 觀眾的 EventSource 會立刻重連（而不是卡在一條死掉的連線上等逾時）。
  const shutdown = () => {
    console.log('\n收到關閉訊號，正在結束 %d 條觀眾連線…', state.viewers.size);
    for (const res of state.viewers) {
      try { res.end(); } catch {}
    }
    state.viewers.clear();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('啟動失敗：', err.message);
  process.exit(1);
});
