#!/usr/bin/env python3
"""QLoRA SFT for the voice HUD's narration -> tool-call specialist.

Base model: Qwen2.5-7B-Instruct (4-bit, unsloth). Trains on the JSONL corpus produced
by `voice-hud/scripts/gen-traces.ts --mode gold` (records shaped
{messages: [...], tools: [...], meta: {...}} in OpenAI tool-calling chat format).

Context (do not re-derive — see SFT_RUN_STATE.md / SPECIALIST_MODEL_DECISION.md /
SFT_TRACE_PLAN.md in the repo root):

  - The 14B does NOT fit a 12GB local card. Training happens on a RENTED RunPod
    RTX 4090 (24GB) at ~$0.34/hr (see training/RUNBOOK.md). This script is meant to
    run there, not on a laptop GPU.
  - Measured local (12GB, r=16) ceilings: seq 1024 -> 6.26 GiB peak, 2048 -> 7.54 GiB,
    3072 -> 9.58 GiB, 4096 -> OOM. On a 24GB 4090 we expect roughly double the headroom,
    so ~8k seq should fit at r=16 — that's why --seq defaults to 8192 below. If you hit
    OOM at 8192 on a 4090, fall back to 4096-6144 rather than assuming the estimate is
    wrong; re-measure and update SFT_RUN_STATE.md.
  - WSL/driver trap: NVIDIA has been observed to silently spill CUDA allocations to
    system RAM instead of raising an OOM error — this LOOKS like an ordinary ~50x
    slowdown with no crash, not a crash. We guard against silently trusting a slow-but-
    not-crashing run by (a) capping the CUDA memory fraction so a real overrun becomes a
    hard OOM instead of a silent spill, and (b) logging peak allocated memory every N
    steps so a spill shows up as a peak-vs-expected anomaly even if it doesn't crash.
  - Qwen's vocab is ~152k tokens. A naive `model(input_ids, labels=...)` materializes a
    full fp32 logits tensor over that vocab for every position, ~5 GiB by itself at
    modest batch/seq sizes. We train exclusively through trl's SFTTrainer, which chunks
    the cross-entropy computation — never hand-roll the loss/logits path here.
  - unsloth writes a `unsloth_compiled_cache/` directory into the CURRENT WORKING
    DIRECTORY at import/compile time. Run this script from a scratch directory (see
    RUNBOOK.md) so that cache doesn't land in the repo; it's also .gitignore'd as a
    backstop.

Usage:
    python train_qlora.py --data data/traces-gold.jsonl --out out/qwen7b-dm-lora
    python train_qlora.py --data data/traces-gold.jsonl --out out/qwen7b-dm-lora \
        --merge-gguf --quant q4_k_m
"""

from __future__ import annotations

import argparse
import json
import os
import random
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any


# ── CLI ──────────────────────────────────────────────────────────────────────
def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--data", required=True, help="JSONL corpus (gen-traces.ts --mode gold output)")
    p.add_argument("--base", default="unsloth/Qwen2.5-7B-Instruct-bnb-4bit",
                   help="Base model (unsloth 4-bit repo id, or a local path)")
    p.add_argument("--out", default="out/qwen7b-dm-lora", help="Output directory for the LoRA adapter")
    p.add_argument("--seq", type=int, default=8192,
                   help="Max sequence length. Local (12GB) measured ceilings: 1024->6.26GiB, "
                        "2048->7.54GiB, 3072->9.58GiB, 4096->OOM. A 24GB 4090 should fit ~8k "
                        "at r=16 (default here); re-measure before trusting it on a different GPU.")
    p.add_argument("--rank", type=int, default=16, help="LoRA rank")
    p.add_argument("--alpha", type=int, default=None, help="LoRA alpha (default: 2x rank)")
    p.add_argument("--epochs", type=float, default=2)
    p.add_argument("--lr", type=float, default=1e-4)
    p.add_argument("--bs", type=int, default=1, help="Per-device train batch size")
    p.add_argument("--grad-accum", type=int, default=8, dest="grad_accum")
    p.add_argument("--seed", type=int, default=1)
    p.add_argument("--val-frac", type=float, default=0.05, help="Held-out fraction for eval loss")
    p.add_argument("--mem-fraction", type=float, default=0.95,
                   help="torch.cuda.set_per_process_memory_fraction — forces a hard OOM instead "
                        "of a silent host-RAM spill (see WSL/driver trap above)")
    p.add_argument("--log-mem-every", type=int, default=25, dest="log_mem_every",
                   help="Log peak CUDA memory every N optimizer steps")
    p.add_argument("--merge-gguf", action="store_true", dest="merge_gguf",
                   help="After training, export a merged q4_k_m GGUF via unsloth's save_pretrained_gguf")
    p.add_argument("--quant", default="q4_k_m", help="GGUF quantization method for --merge-gguf")
    p.add_argument("--max-samples", type=int, default=None, dest="max_samples",
                   help="Debug: cap the number of training records loaded")
    return p.parse_args(argv)


# ── Corpus loading / chat-template formatting ───────────────────────────────
# Kept import-light and torch-free so smoke_test.py can exercise this logic on CPU
# without needing CUDA, unsloth, or even torch installed.

@dataclass
class LoadedRecord:
    messages: list[dict[str, Any]]
    tools: list[dict[str, Any]]
    meta: dict[str, Any]


def load_jsonl(path: str, max_samples: int | None = None) -> list[LoadedRecord]:
    """Load gen-traces.ts's {messages, tools, meta} JSONL records.

    Tolerant of blank lines; raises on malformed JSON (a producer bug should be loud,
    not silently skipped — see CLAUDE.md's "no symptom-patching" convention).
    """
    records: list[LoadedRecord] = []
    with open(path, "r", encoding="utf-8") as f:
        for lineno, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError as e:
                raise ValueError(f"{path}:{lineno}: malformed JSON: {e}") from e
            if "messages" not in obj or "tools" not in obj:
                raise ValueError(f"{path}:{lineno}: record missing 'messages' or 'tools' key")
            records.append(LoadedRecord(messages=obj["messages"], tools=obj["tools"], meta=obj.get("meta", {})))
            if max_samples is not None and len(records) >= max_samples:
                break
    if not records:
        raise ValueError(f"{path}: no records loaded (empty file, or every line was blank)")
    return records


def openai_tools_to_qwen_tools(tools: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """gen-traces.ts's ToolSpec is {name, description, parameters}; Qwen2.5's chat
    template (via transformers apply_chat_template(..., tools=...)) expects the
    OpenAI function-calling wrapper {type: "function", function: {...}}. Normalize."""
    out = []
    for t in tools:
        if "type" in t and t.get("type") == "function":
            out.append(t)
        else:
            out.append({"type": "function", "function": {
                "name": t["name"], "description": t.get("description", ""),
                "parameters": t.get("parameters", {"type": "object", "properties": {}}),
            }})
    return out


def render_chat_text(tokenizer, messages: list[dict[str, Any]], tools: list[dict[str, Any]]) -> str:
    """Apply Qwen2.5's chat template WITH tools. Qwen2.5-Instruct's template natively
    supports a `tools` kwarg and renders assistant tool_calls as its own <tool_call>
    JSON blocks, and tool results as tool-role turns — this is what lets a model
    trained on this format actually learn Qwen's own function-calling syntax rather
    than an OpenAI-shaped syntax it was never trained to emit."""
    return tokenizer.apply_chat_template(
        messages, tools=openai_tools_to_qwen_tools(tools), tokenize=False, add_generation_prompt=False,
    )


# Qwen2.5's chat template renders each turn between these role markers. We rely on
# `unsloth.chat_templates.train_on_responses_only`, which masks loss to everything
# between an "instruction" marker and a "response" marker; for Qwen2.5-Instruct those
# are "<|im_start|>user\n" / "<|im_start|>assistant\n" (tool-role turns are folded
# into the user-side prefix leading to the next assistant turn, so tool RESULTS are
# correctly excluded from the loss too — the model should never learn to predict
# what a tool returns, only what to call and what to say).
QWEN_INSTRUCTION_PART = "<|im_start|>user\n"
QWEN_RESPONSE_PART = "<|im_start|>assistant\n"


def build_dataset(records: list[LoadedRecord], tokenizer):
    """Returns a HF `datasets.Dataset` with a single `text` column, one Qwen-chat-
    template-rendered conversation per record. trl's SFTTrainer + unsloth's
    train_on_responses_only handle tokenization and loss masking downstream — this
    function's only job is correct templating, so it's covered by smoke_test.py."""
    from datasets import Dataset

    texts = [render_chat_text(tokenizer, r.messages, r.tools) for r in records]
    return Dataset.from_dict({"text": texts})


# ── Training ─────────────────────────────────────────────────────────────────
def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)

    # Imported lazily (not at module top) so `python -c "import train_qlora"` and
    # smoke_test.py's CPU-only checks don't require torch/CUDA/unsloth to be installed.
    import torch
    from unsloth import FastLanguageModel
    from unsloth.chat_templates import train_on_responses_only
    from trl import SFTConfig, SFTTrainer

    random.seed(args.seed)

    if torch.cuda.is_available():
        # WSL/driver trap: cap the allowed fraction so a real overrun raises a hard
        # CUDA OOM instead of silently spilling into system RAM (see module docstring).
        torch.cuda.set_per_process_memory_fraction(args.mem_fraction)
        torch.manual_seed(args.seed)
    else:
        print("WARNING: no CUDA device visible — this script expects a rented GPU "
              "(see training/RUNBOOK.md); continuing anyway (will be extremely slow).",
              file=sys.stderr)

    print(f"[train_qlora] loading base model {args.base} (seq={args.seq}, 4-bit)")
    model, tokenizer = FastLanguageModel.from_pretrained(
        model_name=args.base,
        max_seq_length=args.seq,
        load_in_4bit=True,
        dtype=None,  # unsloth autodetects bf16/fp16 for the GPU
    )

    alpha = args.alpha if args.alpha is not None else args.rank * 2
    model = FastLanguageModel.get_peft_model(
        model,
        r=args.rank,
        lora_alpha=alpha,
        lora_dropout=0.0,  # unsloth's fast path requires 0 dropout
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
        bias="none",
        use_gradient_checkpointing="unsloth",  # long-context memory saver
        random_state=args.seed,
    )

    print(f"[train_qlora] loading corpus {args.data}")
    records = load_jsonl(args.data, max_samples=args.max_samples)
    print(f"[train_qlora] {len(records)} records loaded")
    random.Random(args.seed).shuffle(records)
    n_val = max(1, int(len(records) * args.val_frac)) if len(records) > 20 else 0
    val_records, train_records = records[:n_val], records[n_val:]
    print(f"[train_qlora] split: {len(train_records)} train / {len(val_records)} val")

    train_ds = build_dataset(train_records, tokenizer)
    val_ds = build_dataset(val_records, tokenizer) if val_records else None

    sft_config = SFTConfig(
        output_dir=args.out,
        per_device_train_batch_size=args.bs,
        gradient_accumulation_steps=args.grad_accum,
        num_train_epochs=args.epochs,
        learning_rate=args.lr,
        max_seq_length=args.seq,
        dataset_text_field="text",
        packing=False,  # tool-call traces are variable-length turns; packing would
                        # blur assistant-turn boundaries that train_on_responses_only needs
        logging_steps=1,
        save_strategy="epoch",
        eval_strategy="epoch" if val_ds is not None else "no",
        bf16=torch.cuda.is_bf16_supported() if torch.cuda.is_available() else False,
        fp16=not (torch.cuda.is_available() and torch.cuda.is_bf16_supported()),
        optim="adamw_8bit",
        seed=args.seed,
        report_to=[],
    )

    trainer = SFTTrainer(
        model=model,
        tokenizer=tokenizer,
        train_dataset=train_ds,
        eval_dataset=val_ds,
        args=sft_config,
    )

    # Mask loss to assistant turns only. Without this, the model spends most of its
    # gradient signal learning to regurgitate the 5-9k-token tool-schema prefix
    # (verbatim JSON schemas) rather than learning the narration->tool-call mapping —
    # see the module docstring / SFT_TRACE_PLAN.md.
    trainer = train_on_responses_only(
        trainer,
        instruction_part=QWEN_INSTRUCTION_PART,
        response_part=QWEN_RESPONSE_PART,
    )

    _install_mem_logging_callback(trainer, args.log_mem_every)

    print(f"[train_qlora] starting training: epochs={args.epochs} lr={args.lr} "
          f"bs={args.bs} grad_accum={args.grad_accum} rank={args.rank} alpha={alpha} seq={args.seq}")
    t0 = time.time()
    train_result = trainer.train()
    wall_s = time.time() - t0

    total_tokens = _estimate_tokens(train_records, tokenizer)
    tok_per_sec = total_tokens * args.epochs / wall_s if wall_s > 0 else 0.0
    print(f"[train_qlora] training done in {wall_s / 60:.1f} min "
          f"(~{tok_per_sec:.0f} tok/s over {total_tokens} corpus tokens x {args.epochs} epochs)")
    if torch.cuda.is_available():
        peak_gib = torch.cuda.max_memory_allocated() / (1024 ** 3)
        print(f"[train_qlora] peak CUDA memory allocated: {peak_gib:.2f} GiB")

    print(f"[train_qlora] saving LoRA adapter to {args.out}")
    model.save_pretrained(args.out)
    tokenizer.save_pretrained(args.out)

    if args.merge_gguf:
        gguf_dir = os.path.join(args.out, "gguf")
        print(f"[train_qlora] merging + exporting GGUF ({args.quant}) to {gguf_dir}")
        model.save_pretrained_gguf(gguf_dir, tokenizer, quantization_method=args.quant)
        print(f"[train_qlora] GGUF export done: {gguf_dir}")

    print(f"[train_qlora] final train_loss={train_result.metrics.get('train_loss')}")


def _estimate_tokens(records: list[LoadedRecord], tokenizer) -> int:
    # Cheap post-hoc estimate for the tok/s log line; not used for anything load-bearing.
    total = 0
    for r in records[: min(len(records), 200)]:
        text = render_chat_text(tokenizer, r.messages, r.tools)
        total += len(tokenizer.encode(text))
    if not records:
        return 0
    avg = total / min(len(records), 200)
    return int(avg * len(records))


def _install_mem_logging_callback(trainer, log_every: int) -> None:
    """Logs peak CUDA memory every N optimizer steps. This is the visibility guard
    against the WSL/driver silent-spill trap: a spill shows up as a slowdown with a
    peak-memory reading that looks wrong for the batch/seq size in use, even though
    nothing crashes — watch this log, not just the loss curve."""
    import torch
    from transformers import TrainerCallback

    class MemLogCallback(TrainerCallback):
        def on_step_end(self, args, state, control, **kwargs):  # noqa: D401
            if not torch.cuda.is_available():
                return
            if state.global_step % log_every == 0:
                peak_gib = torch.cuda.max_memory_allocated() / (1024 ** 3)
                cur_gib = torch.cuda.memory_allocated() / (1024 ** 3)
                print(f"[mem] step={state.global_step} current={cur_gib:.2f}GiB peak={peak_gib:.2f}GiB")

    trainer.add_callback(MemLogCallback())


if __name__ == "__main__":
    main()
