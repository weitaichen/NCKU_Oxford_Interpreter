// 把麥克風的 Float32 音訊轉成 Deepgram 要的 linear16 PCM，每 100ms 送一塊。
// AudioContext 已用 sampleRate: 16000 建立，所以這裡不需要自己降採樣。
class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Int16Array(1600); // 16000Hz x 0.1s
    this.offset = 0;
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
