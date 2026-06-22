// Minimal types for the optional `smart-whisper` native binding (lazy-imported by
// whisperCpp.ts). Lets the spike typecheck without the dep installed; adjust to the
// installed version's actual surface if it drifts.
declare module "smart-whisper" {
  export interface WhisperToken { p?: number; text?: string }
  export interface WhisperSegment { text: string; tokens?: WhisperToken[] }
  export interface TranscribeTask { result: Promise<WhisperSegment[]> }
  export class Whisper {
    constructor(modelPath: string, options?: { gpu?: boolean });
    transcribe(pcm: Float32Array, options?: { language?: string; prompt?: string }): Promise<TranscribeTask>;
    free(): Promise<void>;
  }
}
