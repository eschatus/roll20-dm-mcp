# Plan: GM bridge-state token + turn-hook migration to TS

> **⚠ STATUS: SUPERSEDED / LARGELY INFEASIBLE AS WRITTEN (2026-06-20).** Two premises this plan
> rests on turned out to be false:
> 1. **"Writes → direct RTDB writes."** Roll20's RTDB security rules **deny client writes** to
>    object/`aibridge/*` paths on every shard (verified on `roll20-99910` / `roll20-99922`). All
>    mutating commands still go *through the Mod* via `!ai-relay` over RTDB — the Mod does the
>    `createObj`/`.set()`. The TS client cannot write Roll20 objects (or a custom bridge path)
>    directly.
> 2. **The `bridge-mod` / `bridge-ts` token scheme is blocked.** It needs either TS→RTDB writes
>    (denied) or the Mod reading a TS-written path (the Mod has no Firebase access at all). Neither
>    half of the two-token channel exists.
>
> What actually shipped instead: **HUD payloads (mob plans, `!dm` inbox) are delivered by in-process
> SSE broadcast** from the HTTP server, not a shared bridge token (see `docs/decisions.md` §12).
> Mod globals (`round`, `turnHookEnabled`, `dmInbox`, `mobPlans`) persist in `state.GM_AI_Bridge`
> and are served to TS through normal relay reads (`getDmInbox` / `getTurnHookState`), still over the
> relay — not off a bridge token. The Mod still owns turn-hook auto-narration; TS produces its
> markdown report separately (the two are complementary — see `skills/dm-rules.md`). Auto-roll
> initiative for NPC tokens dropped mid-combat shipped via the Mod's `add:graphic` hook.
>
> The text below is kept for historical context only. Do not implement it without first solving the
> RTDB-write-denied constraint.

---

Deferred from the browserless-RTDB session (branch `feat/browserless-rtdb-transport`). This is the
high-value / high-risk remaining piece. Build it as a focused effort, not at the tail of a marathon.

## Context (what's already true)

After the RTDB work, almost all combat traffic is off chat:
- Reads (tokens, turnorder, markers, doors, paths, chat) → direct off the socket.
- Writes (token props/bars/markers, conditions) → direct RTDB writes.
- PC HP → per-token `%%PCHP={...}%%` block in the token's GM-only `gmnotes` (read/written by BOTH
  the RT client and the Mod; the Mod's `effectiveHp` reads it for turn-hook narration).

Still on the Mod (still ding chat): `createObj*`, `rollInitiative` (dice engine), `batchExec`,
intended `sendNarration`, and the **Mod's turn-hook auto-narration** (`on("change:campaign:turnorder")`).

## Why the bridge token

The Mod can only read Roll20 object fields (`t.get`, `findObjs`, its own `state`) — not arbitrary
RTDB paths or TS files. So **state shared by both runtimes** must live in a Roll20 field both can
touch. A hidden token's `gmnotes` is the proven channel (raw round-trip both directions, GM-only).

**Hard constraint: one `gmnotes` blob = ONE writer.** Read-modify-write on a single string means
two independent writers clobber each other. So partition by writer:
- `bridge-mod` token — written ONLY by the Mod (its authoritative globals), read by TS.
- `bridge-ts` token — written ONLY by TS, read by the Mod.

Per-token, high-frequency state (PC HP, bars, markers) stays per-token — never funnel through one blob.

## Phase 1 — bridge foundation (low risk)

1. **Mod**: on `ready`, find-or-create a singleton `bridge-mod` token (gmlayer, hidden, found by
   name; cache id in `state`). Add `mirrorBridgeState()` writing `{round, turnHookEnabled, dmInbox,
   updatedAt}` as JSON to its gmnotes; call it wherever those change (turn hook, `!dm`, set-turn-hook).
2. **TS** (`src/bridge/bridgeState.ts`): `findBridgeToken()` (scan graphics by name, cache id),
   `readBridgeState()`. Serve `getDmInbox` / `getTurnHookState` as direct reads off the bridge token
   (removes those two from chat). Optional `bridge-ts` token for TS-owned global state if the Mod
   needs to read it (campaignContext, etc.).
3. Restart refresh: either runtime rehydrates global context from the bridge token(s).

Validate: Mod mirror populates the token; TS reads it; getDmInbox/getTurnHookState off chat.

## Phase 2 — turn-hook narration to TS (high value, high risk)

Goal: TS owns combat narration (richer / LLM-driven, single voice) instead of the Mod's templated
HTML round summaries + turn announcements.

1. TS subscribes to `campaign/turnorder` via `onValue` (socket already open). Replicate the Mod's
   round detection (pr-wrap) and turn-advance detection.
2. On round/turn change, TS builds narration reading: PC HP from per-token gmnotes, NPC HP from
   token bars, conditions from statusmarkers, `round`/`dmInbox` from the bridge token. Post via
   `sendNarration` (still chat — intended, player-facing).
3. **Disable the Mod's `on("change:campaign:turnorder")` auto-narration** (guard it off) so it
   doesn't double-fire. After this, TS owns `round`/`turnHookEnabled` → they move to the `bridge-ts`
   token (TS writes), and the Mod reads them from there (single-writer per carrier preserved).
4. `dmInbox` stays Mod-written (populated by `!dm`) on the `bridge-mod` token; TS reads it for
   pending-intent matching.

Risks/validation: this rewrites LIVE combat narration. Test with a scratch encounter before a real
session. Keep the Mod's hook behind a flag so it can be re-enabled instantly if TS narration misfires.
Honor existing narration feedback (round-end unprompted, no numbers to players, assistant-reports vs
DM-narrates). Needs a Mod redeploy.

## Open questions for next session
- Confirm `dmInbox`/`round` are the only Mod globals TS needs.
- Decide narration style: port the Mod's templated summary, or go LLM-generated.
- Whether `batchExec` token-only ops should also split into direct writes (silence bulk updates).
