class SvaraCapture extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel?.length) {
      const samples = Float32Array.from(channel);
      this.port.postMessage(samples, [samples.buffer]);
    }
    return true;
  }
}
registerProcessor("svara-capture", SvaraCapture);
