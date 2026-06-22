// STT factory with an automatic fallback chain. Tries the primary engine config
// (config.stt), then each entry in config.stt.fallbacks in order, until one
// successfully loads. This is the ONE place that maps config → concrete engine;
// main.ts just calls startStt() and uses the returned SttEngine.

import { SttEngine } from "./engine";
import { FasterWhisperEngine } from "./fasterWhisper";
import { WhisperCppEngine } from "./whisperCpp";
import { CONFIG } from "../config";

export { SttEngine, TranscriptResult } from "./engine";

interface EngineStep { model: string; device: string; computeType: string }

export interface SttHandle {
  engine: SttEngine;
  // re-emit so callers can subscribe once and survive a fallback swap
  on(event: "log" | "ready" | "exit", cb: (...args: unknown[]) => void): void;
}

// Build the ordered list of configs to attempt.
function chain(): EngineStep[] {
  const c = CONFIG.stt;
  return [{ model: c.model, device: c.device, computeType: c.computeType }, ...(c.fallbacks || [])];
}

// Start STT, walking the fallback chain until one loads. Throws only if every
// step fails. Diagnostics for each attempt are surfaced via onLog.
export async function startStt(onLog: (m: string) => void): Promise<SttEngine> {
  let lastErr: Error | null = null;

  // Native whisper.cpp engine (SPIKE, opt-in via DMW_STT_ENGINE=whispercpp). Try it
  // first; on any failure (model missing, addon not built) fall through to the
  // Python faster-whisper chain so the gem always comes up.
  if (CONFIG.sttEngine === "whispercpp") {
    const eng = new WhisperCppEngine({ modelPath: CONFIG.whisperModel, gpu: CONFIG.stt.device !== "cpu" });
    eng.on("log", (m) => onLog(String(m)));
    try {
      onLog(`[stt] trying ${eng.name}…\n`);
      await eng.start();
      onLog(`[stt] using ${eng.name}\n`);
      return eng;
    } catch (e) {
      lastErr = e as Error;
      onLog(`[stt] ${eng.name} failed: ${(e as Error).message} — falling back to faster-whisper\n`);
      eng.stop();
    }
  }

  const steps = chain();
  for (const step of steps) {
    const eng = new FasterWhisperEngine({
      python: CONFIG.stt.python, script: CONFIG.stt.script,
      model: step.model, device: step.device, computeType: step.computeType,
    });
    eng.on("log", (m) => onLog(String(m)));
    try {
      onLog(`[stt] trying ${eng.name} on ${step.device}…\n`);
      await eng.start();
      onLog(`[stt] using ${eng.name} (${step.device})\n`);
      return eng;
    } catch (e) {
      lastErr = e as Error;
      onLog(`[stt] ${eng.name} failed: ${(e as Error).message} — falling back\n`);
      eng.stop();
    }
  }
  throw new Error("All STT engines failed to start. Last error: " + (lastErr?.message ?? "unknown"));
}
