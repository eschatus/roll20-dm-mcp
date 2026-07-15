// Pure, DOM-free helpers shared by the renderer (gem.js). Extracted so they can be
// unit-tested under jsdom without booting Electron or the audio graph. gem.js imports
// these; behavior is identical to the previous inline definitions.

// state → status label shown under the gem. An empty string means "no label"
// (idle hides the label element).
export const STATE_LABELS = { idle: "", listening: "listening", thinking: "scrying" };

// Concatenate a list of Float32 PCM chunks into one contiguous Float32Array.
export function mergeChunks(list) {
  let len = 0; for (const c of list) len += c.length;
  const out = new Float32Array(len);
  let off = 0; for (const c of list) { out.set(c, off); off += c.length; }
  return out;
}

// Linear-resample float PCM to targetRate, then write a 16-bit PCM WAV.
export function encodeWav(samples, inRate, targetRate) {
  const ratio = inRate / targetRate;
  const outLen = Math.floor(samples.length / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const s = samples[Math.floor(i * ratio)] || 0;
    const clamped = Math.max(-1, Math.min(1, s));
    out[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  const buffer = new ArrayBuffer(44 + out.length * 2);
  const view = new DataView(buffer);
  const w = (off, str) => { for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i)); };
  w(0, "RIFF"); view.setUint32(4, 36 + out.length * 2, true); w(8, "WAVE");
  w(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, targetRate, true);
  view.setUint32(28, targetRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  w(36, "data"); view.setUint32(40, out.length * 2, true);
  let off = 44; for (let i = 0; i < out.length; i++, off += 2) view.setInt16(off, out[i], true);
  return buffer;
}

// Normalize a teleprompter scroll offset into (-copyH, 0] so two stacked copies wrap
// seamlessly. Uses while-loops so a single call is correct regardless of how large the
// (positive or negative) delta was.
export function wrapScroll(y, copyH) {
  if (!(copyH > 0)) return y;
  while (y <= -copyH) y += copyH;
  while (y > 0) y -= copyH;
  return y;
}
