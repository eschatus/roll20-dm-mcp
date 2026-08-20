# SFT run — state as of 2026-07-28 (resume here after the restart)

## Where we are

Training a specialist for the voice HUD's narration→tool-call step. Decision history:
`SPECIALIST_MODEL_DECISION.md` (measurement/verdict) → `SFT_TRACE_PLAN.md` (plan) →
this file (live run state).

**Hardware verdict (measured, not estimated).** QLoRA on the 12 GB RTX 3080 Ti:

| model | seq | result |
|---|---|---|
| Qwen2.5-14B 4-bit | any | **won't fit** — weights+LoRA alone 9.59 GiB (unsloth) / 12.41 GiB (stock transformers) |
| Qwen2.5-7B 4-bit r=16 | 1024 | fits, peak 6.26 GiB |
| " | 2048 | fits, peak 7.54 GiB |
| " | 3072 | fits, peak 9.58 GiB |
| " | 4096 | OOM |

Training samples need ~5.3–9k tokens of prefix, so **local training is out** — even a
hard-cut 15-tool surface is 3,942 slim tokens of schemas alone (19-tool CORE: 4,783).
→ **Rent a GPU.** RunPod Community RTX 4090 ≈ $0.34/hr; the whole 7B run is ~1–3 h ≈ **$1**.
An A100 40GB (~$0.60/hr) would even fit the 14B for ~$2 if we ever want it.

Two WSL gotchas that cost us time: the NVIDIA driver **silently spills CUDA allocations
into system RAM** instead of OOMing (looks like a 50× slowdown, and reports impossible
"50 GiB peak" numbers) — cap with `torch.cuda.set_per_process_memory_fraction(0.88)` to
get honest failures; and Qwen's 152k vocab makes naive `model(labels=…)` materialize
~5 GiB of fp32 logits — measure through `SFTTrainer`, whose chunked CE avoids it.

WSL env is ready: `~/qlora-env` (torch 2.11+cu130, unsloth 2026.7.5, trl 0.24, peft 0.20),
python3-dev installed, CUDA passthrough live. Probe scripts: `~/fit4.py`, `~/fit6.py`.

## Open PRs

- **#146** — slim tool specs + prompt-compaction measurements (local path only; cloud keeps
  the verbose anti- -32602 descriptions). Finding: the terse local prompt ZEROES the 7B
  (32/36 turns emit no tool call) — for this task a small model needs *more* prompt.
  Best local config: cloud prompt + slim tools ≈ 9k prefix.
- **#148** — registers `mark_dying` / `break_concentration` / `process_round_end_zones` /
  `set_token_class`, which #139/#140/#143 added but never put in any allowlist.
  ⚠ `mark_dying` was renamed to `set_pc_dying` by #168 — allowlist the NEW name.
  ⚠ Check before merge: golden `13a concentration-micro-question` fell 3/3 → 1/3, likely
  because the model now calls `break_concentration` instead of asking the DM first.
- **#145** merged — trace generator + `golden-lib.ts` (`npm run gen:traces`).

## Golden-suite scoreboard (Haiku, loop=full, 3 reps)

58% (pre-fixes) → 81% (after #137–#140/#143/#144) → 78% (with #148's atomic tools; flat
within noise, redistributed). Persistent residue = the model-behavior targets for SFT:
**negative-space marker invention**, the **delete half of zone transitions**, and
reference resolution on epithet names (a 7B weakness: it calls `update_token_hp` but
hits the wrong token).

qwen baselines on the same suite: 14B 28% (33% with local prompt), 7B 22–25%.

## Next actions (in order)

1. **Merge #148** after checking the 13a regression hypothesis (fix is prompt-side if
   confirmed — the tool is for *after* the DM says "Failed").
2. **Gold-trajectory mode in `gen-traces.ts`** — each axis already carries a `check()`
   that knows the correct board effect; add the matching `expectedCalls` so the generator
   can emit correct trajectories directly. This removes the teacher entirely (the 14B only
   scores 28–33%, so grader-filtering its output would starve the convention-heavy axes).
3. **Training script + RunPod runbook** — unsloth QLoRA on Qwen2.5-7B, export GGUF, load
   into ollama locally. Pod: 4090, destroy after; only training leaves the building.
4. **Constrained-decoding control arm** — still unbuilt. Until it exists we cannot claim
   training beat the cheaper fix. Ollama structured outputs on the tool-args path.

RunPod MCP server was added this session; it loads on the next Claude Code start.

## Also outstanding (unrelated to SFT)

`npm run release:mod` before the next live session — `mod-scripts/ai-relay.js` changed
(threshold automation, `breakConcentration`, zone metadata) and the sandbox copy is stale.
