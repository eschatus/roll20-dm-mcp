// STT factory with an automatic fallback chain. Tries the primary engine config
// (config.stt), then each entry in config.stt.fallbacks in order, until one
// successfully loads. This is the ONE place that maps config → concrete engine;
// main.ts just calls startStt() and uses the returned SttEngine.

import { SttEngine } from "./engine";
import { FasterWhisperEngine } from "./fasterWhisper";
import { WhisperCppEngine } from "./whisperCpp";
import { WhisperServerEngine } from "./whisperServer";
import { CONFIG } from "../config";

export { SttEngine, TranscriptResult } from "./engine";

// Optional second engine for the FINAL clip in a two-tier setup (config.whisperFinalModel):
// a bigger/more-accurate resident model for the agent-driving transcript, while fast live
// partials keep using the primary engine. Only meaningful with the resident whisper-server;
// returns null otherwise (caller then uses the primary engine for finals too). Runs on
// whisperServerPort+1 to coexist with the partial-tier server; null on any failure.
export async function startFinalStt(onLog: (m: string) => void): Promise<SttEngine | null> {
  if (!CONFIG.whisperFinalModel || CONFIG.sttEngine !== "whisperserver") return null;
  const eng = new WhisperServerEngine({
    binPath: CONFIG.whisperServerBin,
    modelPath: CONFIG.whisperFinalModel,
    port: CONFIG.whisperServerPort + 1,
  });
  eng.on("log", (m) => onLog(String(m)));
  try {
    onLog(`[stt] two-tier: final clips → ${eng.name} (port ${CONFIG.whisperServerPort + 1})\n`);
    await eng.start();
    return eng;
  } catch (e) {
    onLog(`[stt] two-tier final engine failed: ${(e as Error).message} — finals use the primary engine\n`);
    await eng.stop();
    return null;
  }
}

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

  // Default + blessed path: whisper.cpp. The resident whisper-server is primary (model loads once);
  // the one-shot whisper-cli is the cpp-only fallback. The Python faster-whisper sidecar below is
  // MOTHBALLED (#46) — reached ONLY when explicitly selected via DMW_STT_ENGINE=faster-whisper, so
  // no Python is ever required by default. A cpp engine never falls back to Python.
  if (CONFIG.sttEngine === "whisperserver" || CONFIG.sttEngine === "whispercpp") {
    // Try the selected cpp engine first, then the other cpp engine — never Python.
    const order: Array<"whisperserver" | "whispercpp"> =
      CONFIG.sttEngine === "whispercpp" ? ["whispercpp", "whisperserver"] : ["whisperserver", "whispercpp"];
    for (const which of order) {
      const eng = which === "whisperserver"
        ? new WhisperServerEngine({ binPath: CONFIG.whisperServerBin, modelPath: CONFIG.whisperModel, port: CONFIG.whisperServerPort })
        : new WhisperCppEngine({ binPath: CONFIG.whisperBin, modelPath: CONFIG.whisperModel });
      eng.on("log", (m) => onLog(String(m)));
      try {
        onLog(`[stt] trying ${eng.name}…\n`);
        await eng.start();
        onLog(`[stt] using ${eng.name}\n`);
        return eng;
      } catch (e) {
        lastErr = e as Error;
        onLog(`[stt] ${eng.name} failed: ${(e as Error).message}\n`);
        await eng.stop();
      }
    }
    throw new Error("whisper.cpp STT failed to start (server + cli). Last error: " + (lastErr?.message ?? "unknown"));
  }

  // Mothballed Python faster-whisper sidecar — explicit opt-in only (DMW_STT_ENGINE=faster-whisper).
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
      await eng.stop();
    }
  }
  throw new Error("All STT engines failed to start. Last error: " + (lastErr?.message ?? "unknown"));
}
