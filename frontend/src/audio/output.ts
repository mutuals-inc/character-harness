export class AudioOutput {
  context: AudioContext | null = null;
  private gain: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private cursor = 0;
  private starts = new Map<number, number>();
  private nodes = new Set<AudioBufferSourceNode>();
  private data = new Uint8Array(256);
  private deviceId = "";

  async ready(volume: number, device = "") {
    this.context ??= new AudioContext({ sampleRate: 24000 });
    if (!this.gain) {
      this.gain = this.context.createGain();
      this.analyser = this.context.createAnalyser();
      this.analyser.fftSize = 512;
      this.analyser.connect(this.gain).connect(this.context.destination);
    }
    this.volume(volume);
    if (device || this.deviceId) await this.device(device);
    await this.context.resume();
  }

  async device(id: string) {
    const context = this.context as AudioContext & {
      setSinkId?: (id: string) => Promise<void>;
    };
    if (id && !context?.setSinkId)
      throw new Error(
        "Output selection is unavailable in this browser. Use your system output setting.",
      );
    await context?.setSinkId?.(id);
    this.deviceId = id;
  }

  volume(value: number) {
    if (this.gain) this.gain.gain.value = value;
  }

  push(id: number, bytes: ArrayBuffer) {
    if (!this.context || !this.gain) return;
    const view = new DataView(bytes);
    const count = Math.floor((bytes.byteLength - 1) / 2);
    if (!count) return;
    const buffer = this.context.createBuffer(1, count, 24000);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < count; i++)
      channel[i] = view.getInt16(1 + i * 2, true) / 32768;
    const node = this.context.createBufferSource();
    node.buffer = buffer;
    node.connect(this.analyser!);
    const start = Math.max(this.context.currentTime + 0.035, this.cursor);
    if (!this.starts.has(id)) this.starts.set(id, start);
    node.start(start);
    this.cursor = start + buffer.duration;
    this.nodes.add(node);
    node.onended = () => {
      this.nodes.delete(node);
      node.disconnect();
    };
  }

  remaining(id: number, seconds: number) {
    return this.context && this.starts.has(id)
      ? Math.max(0, this.starts.get(id)! + seconds - this.context.currentTime) *
          1000
      : null;
  }

  level(): number {
    if (!this.analyser) return 0;
    this.analyser.getByteTimeDomainData(this.data);
    return Math.sqrt(
      this.data.reduce((sum, value) => sum + ((value - 128) / 128) ** 2, 0) /
        this.data.length,
    );
  }

  get playing() {
    return this.nodes.size > 0;
  }
  stop() {
    for (const node of this.nodes) {
      node.onended = null;
      node.stop();
      node.disconnect();
    }
    this.nodes.clear();
    this.starts.clear();
    this.cursor = 0;
  }
  async dispose() {
    this.stop();
    await this.context?.close();
    this.context = null;
    this.gain = null;
    this.analyser = null;
    this.deviceId = "";
  }
  async test(volume: number, device = "") {
    await this.ready(volume, device);
    const oscillator = this.context!.createOscillator();
    const envelope = this.context!.createGain();
    oscillator.frequency.value = 440;
    envelope.gain.setValueAtTime(0, this.context!.currentTime);
    envelope.gain.linearRampToValueAtTime(
      0.12,
      this.context!.currentTime + 0.03,
    );
    envelope.gain.exponentialRampToValueAtTime(
      0.001,
      this.context!.currentTime + 0.5,
    );
    oscillator.connect(envelope).connect(this.gain!);
    oscillator.start();
    oscillator.stop(this.context!.currentTime + 0.5);
    oscillator.onended = () => {
      oscillator.disconnect();
      envelope.disconnect();
    };
  }
}
