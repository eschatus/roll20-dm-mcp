# Moved — the whisper.cpp STT spike lives in `dm-whisper`

Tombstoned 2026-08-26. Speech-to-text is entirely the gem's concern, and the gem is at
**https://github.com/eschatus/dm-whisper**: `src/stt/whisperCpp.ts`, `src/stt/index.ts`, the
`DMW_STT_ENGINE` / `DMW_WHISPER_BIN` / `DMW_WHISPER_MODEL` config, the A/B harness
(`npm run ab:stt`, `scripts/ab-stt.ts`), the clip recorder (`npm run record`), and the model-size
tables all went with it on 2026-08-11.

This MCP server has no audio path of any kind — it never sees a microphone, a clip, or a transcript.
It receives tool calls. Nothing in the spike below was ever this repo's code; it lived here only
because the gem was a `voice-hud/` subdirectory until the split.

**The spike's verdict, for the record:** spawn the prebuilt `whisper-cli` executable rather than a
native node binding — no node-gyp, no MSVC/Xcode, no `electron-rebuild`, on the build box or the
user's machine — and GPU becomes a different prebuilt binary at the same spawn args. That is what
made deleting the Python/faster-whisper venv the single biggest packaging simplification available.
Measured, not eyeballed: the A/B harness scored WER and proper-noun recall through the real
production code paths, and the resident-model latency table (`base.en` ~55 ms, `small.en` ~96 ms,
`medium.en` ~197 ms per clip on a 3080 Ti) is what justified defaulting big on a CUDA rig while
holding a 900 ms live-partial budget on lighter targets.

## What stays true of THIS repo

Only one thing, and it is a naming trap rather than a technical one: **STT mishears reach this
server as tool arguments.** A misheard proper noun arrives as a `characterName` that must resolve
against real Roll20 token names — which is why the fuzzy `resolveTokenOrThrow`
(`src/tools/combat.ts`) and the campaign vocab/nickname registries exposed here (`add_vocab`,
`add_nickname` in `src/tools/campaignContext.ts`) earn their keep. The correction layer itself is
upstream in the gem; the failure surfaces down here as "no token matched".
