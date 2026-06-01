// Polymorphic STT engine interface. The HUD depends ONLY on this — it has no
// knowledge of faster-whisper vs. any future engine (whisper.cpp, a cloud STT,
// Vosk, etc.). Add an engine by implementing SttEngine and registering it in the
// factory (stt/index.ts). main.ts is untouched.

import { EventEmitter } from "events";

export interface TranscriptResult {
  text: string;
  avg_logprob: number;
  no_speech_prob: number;
  low_confidence: boolean;
  language: string;
  duration: number;
}

// Events: "ready" (engine loaded), "log" (diagnostics), "exit" (engine died).
export interface SttEngine extends EventEmitter {
  readonly name: string;
  start(): Promise<void>;
  transcribe(wavPath: string, initialPrompt?: string): Promise<TranscriptResult>;
  stop(): void;
}
