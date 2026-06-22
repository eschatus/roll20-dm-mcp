import { describe, it, expect } from "vitest";
import { buildWhisperArgs, parseWhisperJson } from "../src/stt/whisperCpp";

describe("buildWhisperArgs", () => {
  const opts = { binPath: "whisper-cli", modelPath: "m.bin" };

  it("builds the core arg vector (json-full, language, output prefix)", () => {
    const a = buildWhisperArgs(opts, "clip.wav", "clip.out");
    expect(a).toEqual(["-m", "m.bin", "-f", "clip.wav", "-l", "en", "-np", "-ojf", "-of", "clip.out", "-t", "4"]);
  });

  it("appends --prompt only when a non-empty vocab is given", () => {
    expect(buildWhisperArgs(opts, "c.wav", "c.out", "Strahd, Ireena")).toContain("--prompt");
    expect(buildWhisperArgs(opts, "c.wav", "c.out", "Strahd, Ireena")).toContain("Strahd, Ireena");
    expect(buildWhisperArgs(opts, "c.wav", "c.out", "   ")).not.toContain("--prompt");
    expect(buildWhisperArgs(opts, "c.wav", "c.out")).not.toContain("--prompt");
  });

  it("honors a custom thread count", () => {
    expect(buildWhisperArgs({ ...opts, threads: 8 }, "c.wav", "c.out")).toEqual(
      expect.arrayContaining(["-t", "8"]),
    );
  });
});

describe("parseWhisperJson", () => {
  // Shape of whisper.cpp -ojf output (the bits we consume).
  const mk = (segs: Array<{ text: string; tokens?: Array<{ p: number }> }>, language = "en") =>
    JSON.stringify({ result: { language }, transcription: segs });

  it("joins segment text and trims", () => {
    const r = parseWhisperJson(mk([{ text: " Strahd" }, { text: " advances." }]));
    expect(r.text).toBe("Strahd advances.");
    expect(r.language).toBe("en");
  });

  it("flags low confidence when mean token probability is low", () => {
    const lo = parseWhisperJson(mk([{ text: " mumble", tokens: [{ p: 0.2 }, { p: 0.3 }] }]));
    expect(lo.low_confidence).toBe(true);
    const hi = parseWhisperJson(mk([{ text: " clear", tokens: [{ p: 0.9 }, { p: 0.95 }] }]));
    expect(hi.low_confidence).toBe(false);
  });

  it("does not flag low confidence on empty text, and tolerates missing tokens", () => {
    expect(parseWhisperJson(mk([{ text: "  " }])).low_confidence).toBe(false);
    expect(parseWhisperJson(mk([{ text: " hi" }])).low_confidence).toBe(false); // no probs → assume confident
  });
});
