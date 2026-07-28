#!/usr/bin/env python3
"""CPU-only sanity check of the data-loading/chat-template/loss-masking path.

Runs WITHOUT torch CUDA (in fact without torch at all — only `transformers` is
needed, for its tokenizer + apply_chat_template, both CPU operations). The point is
to catch corpus-format bugs and chat-template/masking bugs LOCALLY, before spending
RunPod GPU time on train_qlora.py — see training/RUNBOOK.md step 1.

Usage:
    python smoke_test.py --data path/to/traces.jsonl [--n 5]
    python smoke_test.py                                  (uses a tiny built-in fixture)

Exits non-zero on any failed assertion.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from train_qlora import (  # noqa: E402  (path insert must come first)
    LoadedRecord,
    QWEN_INSTRUCTION_PART,
    QWEN_RESPONSE_PART,
    load_jsonl,
    openai_tools_to_qwen_tools,
    render_chat_text,
)


# ── A tiny built-in fixture so this script is runnable with zero external data ──
FIXTURE_RECORD = {
    "messages": [
        {"role": "system", "content": "You are the DM's table-mechanics assistant."},
        {"role": "user", "content": "The ogre takes 12 slashing damage."},
        {
            "role": "assistant",
            "content": None,
            "tool_calls": [
                {
                    "id": "call_1",
                    "type": "function",
                    "function": {"name": "update_token_hp", "arguments": json.dumps({"characterName": "Ogre", "damage": 12})},
                }
            ],
        },
        {"role": "tool", "tool_call_id": "call_1", "name": "update_token_hp", "content": "ok: Ogre now at 18/30"},
        {"role": "assistant", "content": "Applied."},
    ],
    "tools": [
        {
            "name": "update_token_hp",
            "description": "Adjust a token's HP",
            "parameters": {
                "type": "object",
                "properties": {
                    "characterName": {"type": "string"},
                    "damage": {"type": "number"},
                },
                "required": ["characterName"],
            },
        }
    ],
    "meta": {"scenarioId": 0, "seed": 1, "axis": "delta-damage", "stepIdx": 0, "latencyMs": 123},
}


def write_fixture(tmp_path: Path) -> Path:
    p = tmp_path / "fixture.jsonl"
    with open(p, "w", encoding="utf-8") as f:
        f.write(json.dumps(FIXTURE_RECORD) + "\n")
    return p


def check(label: str, cond: bool, detail: str = "") -> None:
    status = "PASS" if cond else "FAIL"
    print(f"  [{status}] {label}" + (f" — {detail}" if detail and not cond else ""))
    if not cond:
        raise AssertionError(f"{label}: {detail}")


def get_tokenizer():
    # Local import: the only heavy-ish dependency this script needs, and it's a pure
    # CPU tokenizer load — no CUDA, no unsloth, no bitsandbytes.
    from transformers import AutoTokenizer

    # A tokenizer-only load doesn't need the 4-bit weights — any Qwen2.5-Instruct repo
    # with a chat_template.json works. Use the small instruct model to keep the
    # download light for a smoke test; the trained run uses the 7B in train_qlora.py.
    return AutoTokenizer.from_pretrained("Qwen/Qwen2.5-0.5B-Instruct")


def run(records: list[LoadedRecord], n: int) -> None:
    tokenizer = get_tokenizer()
    sample = records[: max(1, n)]
    print(f"Checking {len(sample)} of {len(records)} loaded record(s)...")

    for i, rec in enumerate(sample):
        print(f"\n-- record {i} (axis={rec.meta.get('axis', '?')}) --")

        # 1. Tools normalize to the OpenAI function-calling wrapper shape.
        qwen_tools = openai_tools_to_qwen_tools(rec.tools)
        check("tools normalize to function-wrapper shape",
              all(t.get("type") == "function" and "function" in t for t in qwen_tools),
              f"got {qwen_tools[:1]}")

        # 2. Chat template renders without error and produces non-empty text.
        text = render_chat_text(tokenizer, rec.messages, rec.tools)
        check("chat template renders non-empty text", isinstance(text, str) and len(text) > 0)

        # 3. The rendered text actually contains the instruction/response markers
        #    train_on_responses_only will split on — if these markers aren't present,
        #    loss masking silently masks EVERYTHING (or nothing), and training would
        #    proceed with garbage supervision without ever raising an error.
        check(f'contains instruction marker {QWEN_INSTRUCTION_PART!r}',
              QWEN_INSTRUCTION_PART in text)
        check(f'contains response marker {QWEN_RESPONSE_PART!r}',
              QWEN_RESPONSE_PART in text)

        # 4. At least one assistant turn's content (tool-call JSON and/or prose)
        #    actually appears after a response marker — this is a proxy, without
        #    pulling in unsloth, for "the masked label span would be non-trivial."
        # Split on the response marker and check that some chunk before the next
        # instruction marker has real content beyond whitespace/an immediate stop.
        chunks = text.split(QWEN_RESPONSE_PART)[1:]  # first elem is pre-first-assistant-turn
        check("at least one assistant turn present", len(chunks) > 0)
        non_trivial_spans = 0
        for chunk in chunks:
            body = chunk.split(QWEN_INSTRUCTION_PART)[0]
            # Strip the end-of-turn token(s) Qwen's template appends so we're checking
            # actual generated content, not just template boilerplate.
            stripped = body.replace("<|im_end|>", "").strip()
            if len(stripped) > 0:
                non_trivial_spans += 1
        check("assistant-turn label spans are non-trivial (not all-empty)",
              non_trivial_spans > 0,
              f"{non_trivial_spans}/{len(chunks)} chunks had content")

        # 5. Tool-call arguments round-trip as valid JSON strings (matches what
        #    gen-traces.ts's runStep() writes: JSON.stringify(c.args)) — a producer-
        #    side format bug here would otherwise only surface as a training-time
        #    template-render exception on the GPU box.
        for msg in rec.messages:
            if msg.get("role") == "assistant" and msg.get("tool_calls"):
                for tc in msg["tool_calls"]:
                    args_str = tc["function"]["arguments"]
                    try:
                        json.loads(args_str)
                    except json.JSONDecodeError as e:
                        check("tool_call arguments are valid JSON", False, f"{tc['function']['name']}: {e}")

    print(f"\nAll checks passed on {len(sample)} record(s).")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--data", default=None, help="JSONL corpus to check (default: built-in fixture)")
    p.add_argument("--n", type=int, default=5, help="Number of records to sample-check")
    args = p.parse_args()

    if args.data:
        records = load_jsonl(args.data, max_samples=max(args.n, 50))
    else:
        import tempfile

        with tempfile.TemporaryDirectory() as td:
            fixture_path = write_fixture(Path(td))
            records = load_jsonl(str(fixture_path))
        print("(using built-in fixture — pass --data to check a real corpus file)")

    try:
        run(records, args.n)
    except AssertionError as e:
        print(f"\nSMOKE TEST FAILED: {e}", file=sys.stderr)
        sys.exit(1)
    print("\nsmoke_test.py: OK")


if __name__ == "__main__":
    main()
