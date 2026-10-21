// Feed a user-selected recording through the same MediaStream/AudioWorklet/VAD
// path as the microphone. The trailing silence lets STT commit naturally.
export async function speechRecording(file: File) {
  if (file.size > 20 * 1024 * 1024)
    throw new Error("Keep recordings under 20 MB.");
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(await file.arrayBuffer());
    if (decoded.duration > 120)
      throw new Error("Keep recordings under two minutes.");
    const lead = Math.round(context.sampleRate * 0.3);
    const buffer = context.createBuffer(
      1,
      lead + decoded.length + Math.round(context.sampleRate * 2.5),
      context.sampleRate,
    );
    const samples = buffer.getChannelData(0);
    for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
      const input = decoded.getChannelData(channel);
      for (let i = 0; i < input.length; i++)
        samples[lead + i] += input[i] / decoded.numberOfChannels;
    }
    const source = context.createBufferSource();
    source.buffer = buffer;
    const destination = context.createMediaStreamDestination();
    source.connect(destination);
    let disposed = false;
    return {
      stream: destination.stream,
      start: async (onEnd: () => void) => {
        source.onended = onEnd;
        await context.resume();
        source.start();
      },
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        source.onended = null;
        try {
          source.stop();
        } catch {
          /* not started */
        }
        source.disconnect();
        destination.stream.getTracks().forEach((track) => track.stop());
        await context.close();
      },
    };
  } catch (error) {
    await context.close();
    throw error;
  }
}
