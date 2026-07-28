# QLoRA training runbook — voice HUD narration->tool-call specialist

Trains a Qwen2.5-7B-Instruct QLoRA adapter on the `gen-traces.ts --mode gold` corpus,
merges + exports a q4_k_m GGUF, and loads it into local ollama for evaluation against
the baselines recorded in `SFT_RUN_STATE.md`.

**Read first:** `SFT_RUN_STATE.md` (measured hardware verdict, open items),
`SFT_TRACE_PLAN.md` (why this training run is happening at all — a control arm is
still required, see step 9), `SPECIALIST_MODEL_DECISION.md` (the original "don't
train yet" analysis this run is now superseding).

Do **not** rent the GPU until step 4 — everything before that is local/free.

---

## 0. Prerequisites

- A RunPod account with billing set up (https://runpod.io).
- This repo checked out locally with `voice-hud/` deps installed (`npm install` in
  `voice-hud/`).
- `ollama` installed locally for the final evaluation step.

## 1. Generate the training corpus locally (free, no GPU)

```bash
cd voice-hud
npm install
# Gold-trajectory mode emits {messages, tools, meta} JSONL records directly from the
# scenario generator's own expected-outcome templates (no teacher model needed) —
# see gen-traces.ts's --mode gold flag (added alongside this runbook; if it's not
# there yet, use the ordinary teacher-driven mode against a local qwen-14b-16k first).
npx tsx scripts/gen-traces.ts --seed 1 --scenarios 400 --mode gold \
  --out data/traces/traces-gold-1.jsonl
npx tsx scripts/gen-traces.ts --seed 2 --scenarios 400 --mode gold \
  --out data/traces/traces-gold-2.jsonl
cat data/traces/traces-gold-1.jsonl data/traces/traces-gold-2.jsonl \
  > data/traces/traces-gold-all.jsonl
wc -l data/traces/traces-gold-all.jsonl
```

Sanity-check the corpus format before spending anything on a GPU:

```bash
cd ../training
python smoke_test.py --data ../voice-hud/data/traces/traces-gold-all.jsonl
```

`smoke_test.py` is CPU-only (no torch CUDA needed) — it parses a sample of records,
applies the Qwen chat template, and asserts assistant-turn loss masking produces
non-trivial label spans. If this fails, fix it before renting a GPU; a corpus format
bug caught here costs nothing, the same bug caught mid-training on RunPod costs money.

## 2. Copy the corpus + training script to a scratch dir

`unsloth` writes a compile cache (`unsloth_compiled_cache/`) into the current working
directory — do this from a scratch dir, not the repo checkout, whether locally or on
the pod:

```bash
mkdir -p ~/qlora-scratch/data
cp ../voice-hud/data/traces/traces-gold-all.jsonl ~/qlora-scratch/data/
cp train_qlora.py requirements.txt Modelfile.template ~/qlora-scratch/
```

## 3. Spin up a RunPod RTX 4090 Community pod

- Console: https://www.runpod.io/console/pods -> Deploy.
- GPU: **RTX 4090** (Community Cloud, ~$0.34/hr as of this writing — check current
  pricing, it drifts).
- Template: an official **PyTorch** template (e.g. `runpod/pytorch:2.x-cuda...`) so
  torch + CUDA are preinstalled and `pip install -r requirements.txt` doesn't need to
  resolve the torch/cuda pairing itself.
- Disk: at least 40GB container disk (base model 4-bit ~5GB, GGUF export needs
  working space, checkpoints).
- Expose SSH (RunPod gives you an SSH command from the pod's "Connect" tab) or use
  their web terminal.

## 4. Upload the corpus + script

From your machine (replace `<pod-ssh-target>` with what RunPod's Connect tab gives
you):

```bash
scp -r ~/qlora-scratch <pod-ssh-target>:~/qlora-scratch
```

Or, if using the web terminal, `git clone`/`curl` isn't needed for a private corpus —
scp is simplest for a one-off run.

## 5. On the pod: install deps

```bash
ssh <pod-ssh-target>
cd ~/qlora-scratch
pip install -r requirements.txt
nvidia-smi   # confirm the 4090 (24GB) is visible before spending training time
```

If `unsloth` install fails to match your pod's CUDA version, check
https://github.com/unslothai/unsloth for the current install matrix and fall back to
their recommended pip line for cu12x — the pin in `requirements.txt` is a known-good
snapshot, not guaranteed against RunPod's image drift.

## 6. Run training

```bash
cd ~/qlora-scratch
python train_qlora.py \
  --data data/traces-gold-all.jsonl \
  --base unsloth/Qwen2.5-7B-Instruct-bnb-4bit \
  --out out/qwen7b-dm-lora \
  --seq 8192 --rank 16 --epochs 2 --lr 1e-4 --bs 1 --grad-accum 8 --seed 1 \
  --merge-gguf --quant q4_k_m \
  2>&1 | tee train.log
```

**Expected wall time:** ~1-3 hours for a few-thousand-record corpus at seq=8192 on a
4090 (SFT_RUN_STATE.md's estimate for the whole 7B run). **Expected cost: roughly $1**
at $0.34/hr for a 3h run; budget up to ~$2-3 if the corpus is larger or you re-run
after a config fix.

Watch the log for two things while it runs:
- `[mem] step=... current=...GiB peak=...GiB` lines — if peak memory looks far off
  from what `--seq 8192 --rank 16` should cost (interpolate from the measured local
  ceilings in `SFT_RUN_STATE.md`: 3072->9.58GiB on 12GB) while training is also
  crawling, that's the WSL/driver silent-spill trap even off WSL — investigate before
  trusting the run.
- tokens/sec — sanity-check it isn't degrading over time (a degrading rate on a
  cloud GPU with no thermal excuse usually means something is spilling or swapping).

If you hit OOM at `--seq 8192`, drop to `--seq 6144` or `--seq 4096` and re-run —
don't fight it, the local measurements already show diminishing headroom near 4k on
a smaller card; a 24GB card buys roughly double, not unlimited.

## 7. Download the adapter + GGUF

```bash
# from your local machine
scp -r <pod-ssh-target>:~/qlora-scratch/out/qwen7b-dm-lora ./training/out/
```

This includes both the raw LoRA adapter (`out/qwen7b-dm-lora/`) and the merged GGUF
(`out/qwen7b-dm-lora/gguf/*.gguf`).

## 8. Load into local ollama

```bash
cd training
cp Modelfile.template Modelfile
# edit the FROM line to point at the downloaded .gguf, e.g.:
#   FROM ./out/qwen7b-dm-lora/gguf/unsloth.Q4_K_M.gguf
ollama create dm-whisper-7b -f Modelfile
ollama run dm-whisper-7b "The ogre takes 12 psychic damage and staggers back."
```

## 9. Evaluate against the recorded baselines

**Baselines to beat** (`SFT_RUN_STATE.md`, golden-suite, Haiku loop=full 3 reps):
Haiku 78-81% golden; untrained qwen 7B 22-25% golden, 90% arc (lean, loop=nudge);
untrained qwen 14B 28-33% golden (100% arc at real context — the untrained ceiling
probe, not deployable at 12GB alongside Whisper).

```bash
cd voice-hud
DMW_EVAL_PROVIDER=ollama DMW_EVAL_MODEL=dm-whisper-7b npm run eval:golden
DMW_EVAL_PROVIDER=ollama DMW_EVAL_MODEL=dm-whisper-7b npm run eval:arc
DMW_EVAL_PROVIDER=ollama DMW_EVAL_MODEL=dm-whisper-7b npm run eval:tools
```

**Evaluate with the SAME prompt/tool-scope the model was trained with.** If
`train_qlora.py` was fed a corpus generated against a particular tool allowlist
(check `gen-traces.ts`'s `CONFIG.cloudToolAllowlist ∩ CONFIG.localToolAllowlist`
intersection at generation time) or a particular `buildSystemPrompt` variant, the
eval harness must be pointed at that same scope — grading a model against a wider or
narrower tool surface than it trained on will produce a misleading number in either
direction, not a fair comparison.

**A constrained-decoding control arm is still required before claiming training beat
the cheap fix** (`SPECIALIST_MODEL_DECISION.md`'s verdict, `SFT_TRACE_PLAN.md`'s open
question): untrained 7B + ollama's grammar/JSON-schema-constrained tool-arg decoding
has not yet been measured on the same suite. If that control arm's fully-correct rate
already approaches this trained model's, training didn't earn its cost — build and
run that arm alongside this evaluation, don't skip it just because training is done.

## 10. DESTROY THE POD

**Do this immediately after step 9's downloads complete — an idle 4090 pod keeps
billing at the same ~$0.34/hr whether or not you're using it.**

Console -> Pods -> select the pod -> **Terminate**. Confirm the pod no longer appears
in the active pods list and that billing has stopped (check the RunPod billing page,
not just the console UI — terminated-but-still-billing has happened to people who
stopped at "Stop" instead of "Terminate"; Stop preserves disk and keeps billing at a
reduced storage rate, Terminate is the full stop).

If you plan a second training run within the hour (e.g. re-running after an OOM
config fix), it's fine to leave the pod up between steps 6 and 9 of one continuous
session — the warning above is specifically about walking away after you're done.
