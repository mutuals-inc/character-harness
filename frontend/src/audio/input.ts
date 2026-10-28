import type { Settings } from "../types.ts";

export class Microphone {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private utterance = 0;
  private speaking = false;
  private silence = 0;
  private preRoll: ArrayBuffer[] = [];
  private node: AudioWorkletNode | null = null;
  private generation = 0;
  level = 0;
  running = false;
  get hearingSpeech() {
    return this.running && this.speaking;
  }

  async start(
    settings: Settings,
    send: (data: object | ArrayBuffer) => void,
    voiceStarted: () => void,
    suppliedStream?: MediaStream,
    voiceEnded: () => void = () => {},
  ) {
    await this.stop();
    const generation = this.generation;
    try {
      const stream =
        suppliedStream ??
        (await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: settings.inputDevice
              ? { exact: settings.inputDevice }
              : undefined,
            channelCount: 1,
            echoCancellation: settings.echoCancellation,
            noiseSuppression: settings.noiseSuppression,
            autoGainControl: false,
          },
        }));
      if (generation !== this.generation) {
        stream.getTracks().forEach((track) => track.stop());
        throw new DOMException("Microphone start was cancelled.", "AbortError");
      }
      this.stream = stream;
      this.context = new AudioContext();
      await this.context.audioWorklet.addModule("/pcm-capture.js");
      await this.context.resume();
      this.node = new AudioWorkletNode(this.context, "pcm-capture");
      const source = this.context.createMediaStreamSource(this.stream);
      const silent = this.context.createGain();
      silent.gain.value = 0;
      source
        .connect(this.node)
        .connect(silent)
        .connect(this.context.destination);
      this.running = true;
      this.node.port.onmessage = ({ data }: MessageEvent<Float32Array>) => {
        if (!this.running) return;
        const pcm = new ArrayBuffer(data.length * 2);
        const view = new DataView(pcm);
        let energy = 0;
        for (let i = 0; i < data.length; i++) {
          const sample = Math.max(-1, Math.min(1, data[i] * settings.gain));
          energy += sample * sample;
          view.setInt16(i * 2, sample * 32767, true);
        }
        this.level = Math.sqrt(energy / data.length);
        if (this.level >= settings.threshold) {
          this.silence = 0;
          if (!this.speaking) {
            voiceStarted();
            this.speaking = true;
            send({ t: "stt_start", utterance: ++this.utterance });
            this.preRoll.forEach(send);
            this.preRoll = [];
          }
        } else if (this.speaking) this.silence += data.length / 16;
        if (this.speaking) {
          send(pcm);
          if (this.silence >= settings.silenceMs) {
            send({ t: "stt_eos", utterance: this.utterance });
            this.speaking = false;
            this.silence = 0;
            voiceEnded();
          }
        } else {
          this.preRoll.push(pcm);
          if (this.preRoll.length > 8) this.preRoll.shift();
        }
      };
    } catch (error) {
      if (generation === this.generation) await this.stop();
      throw error;
    }
  }

  async stop() {
    this.generation++;
    this.running = false;
    this.level = 0;
    this.speaking = false;
    this.silence = 0;
    this.preRoll = [];
    if (this.node) {
      this.node.port.onmessage = null;
      this.node.disconnect();
      this.node = null;
    }
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    await this.context?.close();
    this.context = null;
  }
}
