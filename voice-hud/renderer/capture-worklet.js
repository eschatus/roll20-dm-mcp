// capture-worklet.js — off-main-thread mic capture for the gem's PTT live transcription (#43).
//
// Replaces the deprecated ScriptProcessorNode: this runs on the audio render thread, so main-thread
// GC/UI work can't punch holes in the captured audio (the "choppy" dropouts). It posts incremental
// mono Float32 frames (128-sample render quanta) to the main thread, which accumulates them exactly
// like the old onaudioprocess handler. It emits NO audio — the node's output is left silent and the
// gem routes it through a zero-gain GainNode — so the mic never reaches the speakers (no echo).
class CaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    // The input buffer is reused across calls, so post a copy (slice) — structured-cloned to main.
    if (ch && ch.length) this.port.postMessage(ch.slice(0));
    return true; // stay alive for the life of the node (until disconnected)
  }
}
registerProcessor("capture-processor", CaptureProcessor);
