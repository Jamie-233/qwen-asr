// 将麦克风音频重采样为 16kHz、16bit、单声道 PCM，每 100ms（1600 采样 = 3200 字节）发送一次
class PcmWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.pos = 0;
    this.out = new Int16Array(1600);
    this.idx = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    let sum = 0;
    for (let i = 0; i < ch.length; i++) sum += ch[i] * ch[i];
    this.port.postMessage({ level: Math.sqrt(sum / ch.length) });

    // 线性插值重采样
    while (this.pos < ch.length) {
      const i = Math.floor(this.pos);
      const f = this.pos - i;
      const a = ch[i], b = i + 1 < ch.length ? ch[i + 1] : a;
      let s = a + (b - a) * f;
      s = Math.max(-1, Math.min(1, s));
      this.out[this.idx++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.idx === this.out.length) {
        this.port.postMessage({ pcm: this.out.buffer }, [this.out.buffer]);
        this.out = new Int16Array(1600);
        this.idx = 0;
      }
      this.pos += this.ratio;
    }
    this.pos -= ch.length;
    return true;
  }
}
registerProcessor('pcm-worklet', PcmWorklet);
