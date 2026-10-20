// The runtime accepts mono PCM16 at 16 kHz. Resample independently of the hardware rate.
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.position = 0;
    this.frame = new Float32Array(320);
    this.used = 0;
  }
  process(inputs) {
    const samples = inputs[0]?.[0];
    if (!samples) return true;
    const step = sampleRate / 16000;
    while (this.position < samples.length) {
      this.frame[this.used++] = samples[Math.floor(this.position)];
      this.position += step;
      if (this.used === this.frame.length) {
        this.port.postMessage(this.frame, [this.frame.buffer]);
        this.frame = new Float32Array(320);
        this.used = 0;
      }
    }
    this.position -= samples.length;
    return true;
  }
}
registerProcessor("pcm-capture", PcmCapture);
