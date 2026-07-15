import { describe, it, expect } from "vitest";
import { encodeWav, mergeChunks, wrapScroll, STATE_LABELS } from "./gem-core.js";

// Little-endian readers over the WAV header.
function str(view: DataView, off: number, len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) s += String.fromCharCode(view.getUint8(off + i));
  return s;
}

describe("encodeWav", () => {
  it("writes a correct 16-bit mono PCM WAV header", () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1]);
    const buf = encodeWav(samples, 16000, 16000); // ratio 1 → 4 samples out
    const view = new DataView(buf);

    // 44-byte header + 4 samples * 2 bytes
    expect(buf.byteLength).toBe(44 + 4 * 2);
    expect(str(view, 0, 4)).toBe("RIFF");
    expect(view.getUint32(4, true)).toBe(36 + 4 * 2); // chunk size
    expect(str(view, 8, 4)).toBe("WAVE");
    expect(str(view, 12, 4)).toBe("fmt ");
    expect(view.getUint32(16, true)).toBe(16); // fmt chunk length
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(16000); // sample rate
    expect(view.getUint32(28, true)).toBe(16000 * 2); // byte rate (mono, 16-bit)
    expect(view.getUint16(32, true)).toBe(2); // block align
    expect(view.getUint16(34, true)).toBe(16); // bits per sample
    expect(str(view, 36, 4)).toBe("data");
    expect(view.getUint32(40, true)).toBe(4 * 2); // data length
  });

  it("resamples: output length is floor(inputLength / (inRate/targetRate))", () => {
    const samples = new Float32Array(48000); // 1s @ 48k
    const buf = encodeWav(samples, 48000, 16000); // ratio 3 → 16000 samples
    const outSamples = (buf.byteLength - 44) / 2;
    expect(outSamples).toBe(16000);

    // upsampling ratio < 1 also uses floor
    const buf2 = encodeWav(new Float32Array(10), 8000, 16000); // ratio 0.5 → 20
    expect((buf2.byteLength - 44) / 2).toBe(20);
  });

  it("clamps samples to [-1, 1] and maps to int16 range", () => {
    const samples = new Float32Array([1, -1, 2, -2, 0]);
    const buf = encodeWav(samples, 16000, 16000);
    const view = new DataView(buf);
    expect(view.getInt16(44 + 0 * 2, true)).toBe(0x7fff); // +1 → +full
    expect(view.getInt16(44 + 1 * 2, true)).toBe(-0x8000); // -1 → -full
    expect(view.getInt16(44 + 2 * 2, true)).toBe(0x7fff); // +2 clamped to +1
    expect(view.getInt16(44 + 3 * 2, true)).toBe(-0x8000); // -2 clamped to -1
    expect(view.getInt16(44 + 4 * 2, true)).toBe(0); // 0 → 0
  });

  it("produces an empty data section for empty input", () => {
    const buf = encodeWav(new Float32Array(0), 16000, 16000);
    expect(buf.byteLength).toBe(44);
    expect(new DataView(buf).getUint32(40, true)).toBe(0);
  });
});

describe("mergeChunks", () => {
  it("concatenates chunks in order into one Float32Array", () => {
    const out = mergeChunks([
      new Float32Array([1, 2]),
      new Float32Array([3]),
      new Float32Array([4, 5, 6]),
    ]);
    expect(out).toBeInstanceOf(Float32Array);
    expect(Array.from(out)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("returns an empty array for no chunks", () => {
    const out = mergeChunks([]);
    expect(out.length).toBe(0);
  });
});

describe("STATE_LABELS", () => {
  it("maps idle→no label, listening→'listening', thinking→'scrying'", () => {
    expect(STATE_LABELS.idle).toBe("");
    expect(STATE_LABELS.listening).toBe("listening");
    expect(STATE_LABELS.thinking).toBe("scrying");
    // idle's empty string is falsy → the renderer hides the label
    expect(Boolean(STATE_LABELS.idle)).toBe(false);
  });
});

describe("wrapScroll", () => {
  const copyH = 200;

  it("leaves an in-range offset untouched", () => {
    expect(wrapScroll(0, copyH)).toBe(0);
    expect(wrapScroll(-50, copyH)).toBe(-50);
    expect(wrapScroll(-199.999, copyH)).toBeCloseTo(-199.999);
  });

  it("wraps a large negative delta back into (-copyH, 0]", () => {
    for (const y of [-copyH, -copyH - 1, -1000, -5 * copyH - 30]) {
      const w = wrapScroll(y, copyH);
      expect(w).toBeGreaterThan(-copyH);
      expect(w).toBeLessThanOrEqual(0);
    }
  });

  it("wraps a large positive delta back into (-copyH, 0]", () => {
    for (const y of [1, copyH, 3 * copyH + 7, 10000]) {
      const w = wrapScroll(y, copyH);
      expect(w).toBeGreaterThan(-copyH);
      expect(w).toBeLessThanOrEqual(0);
    }
  });

  it("preserves the offset modulo copyH", () => {
    // -230 ≡ -30 (mod 200); +230 ≡ -170 (wrapped into (-200, 0])
    expect(wrapScroll(-230, copyH)).toBeCloseTo(-30);
    expect(wrapScroll(230, copyH)).toBeCloseTo(-170);
  });

  it("returns y unchanged when copyH is not positive", () => {
    expect(wrapScroll(42, 0)).toBe(42);
    expect(wrapScroll(-5, -10)).toBe(-5);
  });
});
