// 把麥克風的 Float32 音訊轉成 Deepgram 要的 linear16 PCM。
//
// 刻意「不」降採樣 —— 直接用 AudioContext 的原生取樣率（通常 48kHz）送出去，
// Deepgram 原生支援。先前強制降到 16kHz 會白白丟掉高頻資訊，拉低辨識率。
// sampleRate 是 AudioWorkletGlobalScope 的全域變數。

class PCMProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const chunkMs = options?.processorOptions?.chunkMs ?? 100;
    this.buffer = new Int16Array(Math.max(256, Math.round((sampleRate * chunkMs) / 1000)));
    this.offset = 0;
    this.port.postMessage({ type: 'ready', sampleRate, frames: this.buffer.length });
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      this.buffer[this.offset++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.offset === this.buffer.length) {
        this.port.postMessage(this.buffer.slice());
        this.offset = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-processor', PCMProcessor);
