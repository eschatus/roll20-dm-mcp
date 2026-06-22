import { describe, it, expect } from "vitest";
import { decodeWav16ToF32 } from "../src/stt/whisperCpp";

// Build a canonical 16 kHz / mono / 16-bit PCM WAV (the format renderer/gem.js
// encodeWav emits), with an optional extra chunk before `data` to exercise the scan.
function makeWav(samples: number[], extraChunk = false): Buffer {
  const dataBytes = samples.length * 2;
  const extra = extraChunk ? 4 + 4 + 4 : 0; // "LIST" + size + 4 bytes payload
  const buf = Buffer.alloc(44 + extra + dataBytes);
  let o = 0;
  buf.write("RIFF", o); o += 4;
  buf.writeUInt32LE(36 + extra + dataBytes, o); o += 4;
  buf.write("WAVE", o); o += 4;
  buf.write("fmt ", o); o += 4;
  buf.writeUInt32LE(16, o); o += 4;
  buf.writeUInt16LE(1, o); o += 2;   // PCM
  buf.writeUInt16LE(1, o); o += 2;   // mono
  buf.writeUInt32LE(16000, o); o += 4;
  buf.writeUInt32LE(32000, o); o += 4;
  buf.writeUInt16LE(2, o); o += 2;
  buf.writeUInt16LE(16, o); o += 2;  // 16-bit
  if (extraChunk) { buf.write("LIST", o); o += 4; buf.writeUInt32LE(4, o); o += 4; buf.write("INFO", o); o += 4; }
  buf.write("data", o); o += 4;
  buf.writeUInt32LE(dataBytes, o); o += 4;
  for (const s of samples) { buf.writeInt16LE(s, o); o += 2; }
  return buf;
}

describe("decodeWav16ToF32", () => {
  it("decodes 16-bit PCM samples to normalized floats", () => {
    const out = decodeWav16ToF32(makeWav([0, 16384, -16384, 32767, -32768]));
    expect(out.length).toBe(5);
    expect(out[0]).toBeCloseTo(0, 5);
    expect(out[1]).toBeCloseTo(0.5, 4);
    expect(out[2]).toBeCloseTo(-0.5, 4);
    expect(out[3]).toBeCloseTo(0.99997, 4);
    expect(out[4]).toBeCloseTo(-1, 4);
  });

  it("finds the data chunk even when another chunk precedes it", () => {
    const out = decodeWav16ToF32(makeWav([16384, -16384], true));
    expect(Array.from(out)).toHaveLength(2);
    expect(out[0]).toBeCloseTo(0.5, 4);
    expect(out[1]).toBeCloseTo(-0.5, 4);
  });

  it("returns empty for a header-only WAV", () => {
    expect(decodeWav16ToF32(makeWav([])).length).toBe(0);
  });
});
