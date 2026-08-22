// 只為了讓觀眾能「加入主畫面」以獨立視窗開啟。
// 字幕必須即時，所以完全不快取任何東西 —— 一律走網路。
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
