// Deepgram 金鑰健檢
//
//   node check-deepgram.mjs
//
// 讀 .env 裡的 DEEPGRAM_API_KEY，逐項確認這把 key 能做什麼：
// 能不能轉錄、能不能發短期 token、WebSocket 串流通不通。
// 換新 key 之後跑一次就知道有沒有換對。

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(fileURLToPath(import.meta.url));

const raw = await readFile(join(ROOT, '.env'), 'utf8').catch(() => '');
const key = (/^DEEPGRAM_API_KEY=(.*)$/m.exec(raw)?.[1] || process.env.DEEPGRAM_API_KEY || '').trim();
const language = (/^STT_LANGUAGE=(.*)$/m.exec(raw)?.[1] || 'en-GB').trim();
const model = (/^STT_MODEL=(.*)$/m.exec(raw)?.[1] || 'nova-3').trim();

if (!key) {
  console.error('讀不到 DEEPGRAM_API_KEY（.env 或環境變數都沒有）');
  process.exit(1);
}

const H = { authorization: `Token ${key}`, 'content-type': 'application/json' };
const line = (label, ok, detail) =>
  console.log(`  ${ok ? '✓' : '✗'}  ${label.padEnd(30)} ${detail}`);

console.log(`\nDeepgram 金鑰健檢  （key 長度 ${key.length}，開頭 ${key.slice(0, 4)}…）\n`);

// 1. 這把 key 是誰、有什麼 scope
let scopes = [];
try {
  const res = await fetch('https://api.deepgram.com/v1/auth/token', { headers: H });
  if (res.ok) {
    const me = await res.json();
    scopes = me.scopes || [];
    line('金鑰有效', true, `${me.email || '?'}   scopes: ${scopes.join(', ') || '（無）'}`);
  } else {
    line('金鑰有效', false, `HTTP ${res.status} — key 可能無效或已刪除`);
    process.exit(1);
  }
} catch (e) {
  line('金鑰有效', false, e.message);
  process.exit(1);
}

// 2. 轉錄權限（沒有這個就完全不能用）
let canTranscribe = false;
{
  const wav = Buffer.alloc(44 + 16000 * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + 32000, 4); wav.write('WAVE', 8);
  wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(32000, 40);

  const res = await fetch(`https://api.deepgram.com/v1/listen?model=${model}&language=${language}`, {
    method: 'POST',
    headers: { authorization: `Token ${key}`, 'content-type': 'audio/wav' },
    body: wav,
  }).catch(() => null);
  canTranscribe = Boolean(res?.ok);
  line('轉錄權限', canTranscribe, canTranscribe ? `${model} / ${language} 可用` : `HTTP ${res?.status ?? '連線失敗'}`);
}

// 3. 短期 token（有的話最安全，沒有也還能跑）
let canGrant = false;
{
  const res = await fetch('https://api.deepgram.com/v1/auth/grant', {
    method: 'POST', headers: H, body: JSON.stringify({ ttl_seconds: 300 }),
  }).catch(() => null);
  canGrant = Boolean(res?.ok);
  line('發放短期 token', canGrant,
    canGrant ? '可用 → 系統會走安全模式，key 不會離開伺服器'
             : `HTTP ${res?.status ?? '?'} → 會退回把 key 直接交給收音頁`);
}

// 4. 實際串流（正式運作走的就是這條）
{
  const params = new URLSearchParams({
    model, language, encoding: 'linear16', sample_rate: '16000', channels: '1',
    interim_results: 'true', smart_format: 'true', punctuate: 'true',
  });
  const pcm = Buffer.alloc(32000);
  for (let i = 0; i < 16000; i++) pcm.writeInt16LE(Math.round(Math.sin(i * 0.173) * 8000), i * 2);

  const ok = await new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const timer = setTimeout(() => finish(false), 12000);
    let ws;
    try {
      ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${params}`, ['token', key]);
    } catch { clearTimeout(timer); return finish(false); }
    ws.onopen = () => {
      for (let o = 0; o < pcm.length; o += 3200) ws.send(pcm.subarray(o, o + 3200));
      setTimeout(() => { try { ws.send(JSON.stringify({ type: 'CloseStream' })); } catch {} }, 400);
    };
    ws.onmessage = (e) => {
      if (JSON.parse(e.data).type === 'Metadata') { clearTimeout(timer); try { ws.close(); } catch {} finish(true); }
    };
    ws.onclose = () => { clearTimeout(timer); finish(done); };
    ws.onerror = () => {};
  });
  line('WebSocket 串流', ok, ok ? 'subprotocol 認證通過，即時字幕可運作' : '連線失敗');
}

// ---- 結論 ----
console.log('');
if (!canTranscribe) {
  console.log('  結論：這把 key 不能轉錄，系統無法運作。請重新建立一把。\n');
  process.exit(1);
} else if (canGrant) {
  console.log('  結論：權限完整 ✓  系統會使用短期 token，API key 不會傳到瀏覽器。\n');
} else {
  console.log('  結論：可以運作，但安全性打折。');
  console.log('        這把 key 不能發短期 token，系統會把 API key 直接交給收音頁，');
  console.log('        代表拿到 OPERATOR_KEY 的人也拿得到你的 Deepgram key。');
  console.log('');
  console.log('        改善方式：console.deepgram.com → Settings → API Keys →');
  console.log('        Create a New API Key，Permissions 選 Member 以上，換上去即可。');
  console.log('        系統會自動偵測並切回安全模式，不用改任何程式碼。\n');
}
