# Connectivity hardening — implementation prompt series

Each prompt below is self-contained and intended for a fresh Sonnet session working in
`e:\personalProjects\roll20-dm-mcp`. Run them **in order** — later prompts assume earlier
ones have landed. After each prompt: `npm run build` must pass at the repo root, and
`cd voice-hud && npm run build` must pass when HUD files were touched. Commit per prompt.

Shared context to paste at the top of every session:

> This repo is an MCP server that drives Roll20 as a DM assistant. Connectivity stack,
> top to bottom: (1) `src/bridge/roll20-rt.ts` — "RT" transport, a direct Firebase RTDB
> socket to Roll20's backend; serves reads off the socket and pushes `!ai-relay` commands
> as chat children for a Mod script (`mod-scripts/ai-relay.js`) running in Roll20's API
> sandbox, awaiting `AIBRIDGE_RESULT:` whispers back. (2) `src/bridge/roll20.ts` —
> Playwright fallback: drives a real Chromium editor tab, with client-direct Backbone
> reads and a chat-typing relay. (3) `src/bridge/browser.ts` — Chromium singleton with
> CDP reattach. (4) `src/index-http.ts` — HTTP MCP server on :39200, shared by Claude
> Code and an Electron voice HUD (`voice-hud/`), plus an SSE `/events` endpoint pushing
> RTDB events to the HUD. Key invariant: **reads may be retried/fallen-back freely;
> mutating writes must never be re-sent with a new nonce after a timeout** (the Mod's
> idempotency is same-nonce only). `READONLY_ACTIONS` in `roll20.ts` is the canonical
> read allowlist. The Roll20 API sandbox sleeps when nobody is connected to the game —
> Mod-destined commands then time out until something joins and wakes it.

---

## Prompt 1 — Stop `/events` from launching Chromium in a retry loop

**Problem.** In `src/index-http.ts`, the `/events` SSE handler calls
`startRtdbSubscriptions()` unconditionally on every connection. If RT auth fails (no
cached token in `data/roll20-rt-token.json`, or the Roll20 session cookie is stale),
`startRtdbSubscriptions` in `src/bridge/roll20-rt.ts` resets `_subscriptionsStarted = false`
and throws. The HUD (`voice-hud/src/main.ts`, `connectEventStream`) retries the SSE
connection every 3–10 s. Each retry re-enters `startRtdbSubscriptions` →
`getConn()` → `getCustomToken()` → potentially `harvestCustomToken()`, which **launches
a Playwright Chromium, navigates to the Roll20 editor, and deletes its IndexedDB**.
Result: a failing auth loops Chromium launches every few seconds.

**Task.** Add backoff + single-flight to the subscription startup in
`src/bridge/roll20-rt.ts`:

- Keep a module-level `_subsLastAttempt` timestamp and `_subsInFlight: Promise<void> | null`.
- In `startRtdbSubscriptions()`: if a start is already in flight, return that promise.
  If the last failed attempt was < 60 s ago, throw a cheap
  `Error("rtdb subscriptions: backing off after recent failure")` **without** calling
  `getConn()`.
- On success, clear the backoff state.
- In `src/index-http.ts`, the `.catch` already forwards the error over SSE — keep that,
  but only send it once per connection (it already does).

**Acceptance.** With no token cache and the browser logged out, repeated `/events`
connections must not launch Chromium more than once per minute. `npm run build` passes.

---

## Prompt 2 — HUD: make `connectEventStream` single-instance

**Problem.** In `voice-hud/src/main.ts`, `connectEventStream()` is called at startup
**and** from the `reconnect-mcp` IPC handler. Nothing closes the previous SSE request,
so each reconnect press adds a parallel `/events` stream. Every RTDB event is then
handled N times: `inboxCount++` double-counts, `combat-update` sends are duplicated to
the renderer, and each dead stream also has its own `setTimeout` retry loop that
resurrects more connections.

**Task.** In `voice-hud/src/main.ts`:

- Add a module-level `let _eventsReq: import("http").ClientRequest | null = null;` and a
  generation counter `let _eventsGen = 0;`.
- At the top of `connectEventStream()`: increment the generation, capture it in a local
  `const gen`, and `_eventsReq?.destroy()` the previous request.
- Store the new request in `_eventsReq`.
- In every retry callsite inside (`setTimeout(connectEventStream, …)` on non-200, `end`,
  and both `error` handlers), only retry if `gen === _eventsGen` (a newer connection
  supersedes this one) and `!appQuitting`.

**Acceptance.** Pressing the config panel's Reconnect button repeatedly results in
exactly one live `/events` connection (verify via log lines — add a
`console.error("[events] connected (gen N)")` on 200). `cd voice-hud && npm run build`
passes.

---

## Prompt 3 — Don't replay historical `!dm` messages into the inbox

**Problem.** In `src/bridge/roll20-rt.ts`, `connect()` subscribes with
`onChildAdded(query(chatRef, limitToLast(CHAT_BUFFER_MAX)))`, which **replays the last
100 chat children** on every (re)connect. `rtReconnect()` also clears `seenKeys`. The
replay flows through `handleChatChild`, which pushes any `!dm `-prefixed message into
`${storagePath}/aibridge/dmInbox` — so every reconnect re-creates inbox entries for
historical player messages.

**Task.** In `src/bridge/roll20-rt.ts`:

- Record a `const connectedAt = Date.now()` inside `connect()` before subscribing, and
  thread it to `handleChatChild` (e.g. make `handleChatChild(key, val, opts: { liveSince: number })`
  or capture via closure).
- Roll20 chat children have a `.priority` server timestamp but `snap.val()` may not
  expose a usable wall-clock. Simplest robust approach: treat the **initial replay
  burst** as history — set a `let live = false;` flag in the closure, flip it to `true`
  on a `setTimeout(…, 2000)` after subscribing (RTDB delivers the replay synchronously
  on connection, well within 2 s), and only do the `!dm` → inbox push when `live` is
  true. Chat buffering (`bufferChat`) SHOULD still run during replay — that's what
  populates `getRecentChat` after a restart. Pending-relay resolution
  (`tryResolveContent`) must also still run during replay (a result may race the
  subscription).
- Do **not** clear `seenKeys` in `rtReconnect()` anymore — it exists precisely to
  dedupe across reconnects. Cap it with the existing size guard.

**Acceptance.** After `rtReconnect()`, no new children appear under `aibridge/dmInbox`
for old messages (manual check or a recon script under `src/recon/`). Live `!dm`
messages sent after reconnect still arrive. `npm run build` passes.

---

## Prompt 4 — Writes must never cross transports after a timeout

> **⚠ SUPERSEDED — the shipped fix is the opposite of this prompt.** Rather than blocking
> cross-transport fallback for mutating post-send timeouts, the implementation made the fallback
> *idempotent*: a single nonce is generated once per command (before either transport) and threaded
> through, so an rt→browser fallback re-sends the **same** nonce. The Mod's `PROCESSED_NONCES` LRU
> deduplicates the resend, so re-running a mutating command on the browser path can't double-apply.
> `shouldFallback(action, err)` therefore now returns `true` unconditionally (see
> `src/bridge/relay-fallback.test.ts`). The `RtPreSendError` / "must re-throw / verify state"
> design below was **not** adopted — ignore it for current behavior. (The circuit-breaker fast-fail
> in Prompt 5 *did* ship.)

**Problem (as originally framed).** In `src/bridge/roll20.ts` (`relayCommand`), RT mode does:
`rtRelayCommand<T>(cmd).catch(err => _relayDefault<T>(cmd))` — for **all** actions.
If a mutating write times out on RT (classic case: the API sandbox is asleep and
processes the chat child late), the catch re-sends the same command through the browser
path with a **new nonce**, defeating the Mod's same-nonce idempotency → double damage /
duplicate tokens / double turn-advance. The in-process retry logic in
`_relayCommandRaw` already refuses exactly this; the cross-transport seam violates it.

**Task.** In `src/bridge/roll20.ts`:

- `READONLY_ACTIONS` already exists at the top of the file. In the `rtEnabled()` branch
  of `relayCommand`, split behavior:
  - Read-only action → keep the current fallback (`.catch → _relayDefault`).
  - Mutating action → distinguish **pre-send** failures from **post-send** ones. Add an
    exported marker class in `roll20-rt.ts`: `export class RtPreSendError extends Error {}`.
    In `rtRelayCommand`, wrap everything **before** the `set(msgRef, …)` push (i.e.
    `getConn()` and token/auth failures) so those reject with `RtPreSendError`. A
    pre-send failure means the command never reached `/chat` → safe to fall back to the
    browser path. A post-send failure (timeout waiting for `AIBRIDGE_RESULT`) must
    **re-throw** with a message like:
    `"rt relay timeout for mutating action '<action>' — NOT retried on browser to avoid double-apply; verify state in Roll20 before re-issuing"`.
- Note: direct RTDB writes inside `tryDirectWrite` never touch `/chat`; their internal
  `catch → NOT_HANDLED → Mod path` flow is a *first* send, not a retry — leave it.

**Acceptance.** Unit-testable without live Roll20: add a small test (pattern: existing
`src/bridge/rt-helpers.test.ts` uses vitest) that stubs/mocks to verify (a) read-only
timeout falls back, (b) mutating post-send timeout rejects without invoking the browser
path, (c) mutating pre-send failure falls back. If mocking the firebase module is too
heavy, test the decision function by extracting it as a pure helper
(`shouldFallback(action, err): boolean`) and unit-test that. `npm run build` and
`npx vitest run` pass.

---

## Prompt 5 — Transport health: circuit breaker + tiered timeouts

**Problem.** Every layer discovers failure by flat 30 s timeout
(`RELAY_TIMEOUT_MS` in both `roll20.ts` and `roll20-rt.ts`), and nothing remembers the
last failure — so when the sandbox is asleep, *every* call pays the full chain
(30 s RT + navigation + 30 s chat relay). This is the root of "hit or miss" feel.

**Task.** Create `src/bridge/transport-health.ts`:

```ts
export type TransportName = "rt" | "browser";
export type Health = "ok" | "degraded" | "down";
// recordSuccess(name), recordFailure(name), getHealth(name): Health
// Health rules: down = 2+ consecutive failures within the last 60s (clears after 60s
// quiet); degraded = 1 recent failure; ok otherwise. Keep it tiny and dependency-free.
```

Wire it in:

- `src/bridge/roll20-rt.ts`: `rtRelayCommand` records success on resolve, failure on
  timeout/auth error. **Tiered timeout:** read-only actions (import `READONLY_ACTIONS`
  from `roll20.ts` — move the set into a new shared module `src/bridge/actions.ts` to
  avoid a circular import) use `8_000` ms; mutating actions keep `30_000`.
- `src/bridge/roll20.ts` `relayCommand`, RT branch: if `getHealth("rt") === "down"` and
  the action is read-only, skip RT entirely and go straight to `_relayDefault`
  (log one line: `[roll20] rt circuit open — routing <action> to browser`). Mutating
  actions still attempt RT (writes must not silently change transport — see Prompt 4 —
  but a known-down RT should *also* fail fast: if down, throw immediately with the
  same "verify state" message rather than waiting 30 s. A down circuit means the last
  writes timed out post-send, so the operator needs to look at Roll20 anyway).
- Record success/failure for the browser path too (in `_relayCommandRaw`).
- New MCP tool `transport_status` in `src/server-combat.ts` (follow the registration
  pattern of an existing trivial read tool like `active_campaign`): returns
  `{ rt: Health, browser: Health, rtEnabled: boolean, activeCampaign: string }`.

**Acceptance.** Build + existing tests pass. With RT marked down (simulate by two
recorded failures), a `getTokens`-style read routes to the browser without an 8 s wait,
and `transport_status` reports it. Add a vitest for the health state machine
(`transport-health.test.ts`).

---

## Prompt 6 — Sandbox watchdog: detect and wake a sleeping/crashed Mod

**Problem.** The Roll20 API sandbox sleeps when nobody is connected to the game and
crashes outright on certain bad writes (see memory: undefined → `t.set()` kills it).
In RT (browserless) mode nothing keeps it awake, so Mod-destined commands time out
until a real client joins. `reconnectRoll20()` in `src/bridge/roll20.ts` already does
the full wake dance (relaunch browser, join editor, reinstall observer) — it's just
never invoked automatically.

**Task.**

- In `src/bridge/roll20-rt.ts` add `export async function pingMod(timeoutMs = 6_000): Promise<boolean>` —
  sends `{ action: "ping" }` through the normal `rtRelayCommand` machinery but with the
  short timeout and **without** recording a health failure on miss (it's a probe).
  Return true/false, never throw.
- New module `src/bridge/sandbox-watchdog.ts`:
  - `startWatchdog()` — interval (default 5 min, env `SANDBOX_WATCHDOG_MS`, `0` disables)
    that runs `pingMod()`. On miss: log, then call `reconnectRoll20({ hard: false })`
    from `roll20.ts` once (joining the editor wakes the sandbox), wait 20 s, ping again.
    On second miss: log loudly
    (`[watchdog] sandbox unreachable after wake attempt — Mod may have crashed; check the API console`)
    and **stop auto-attempting** until a ping succeeds again (don't relaunch-loop).
  - Single-flight: never overlap wake attempts.
- Start it from `src/index-http.ts` after the server starts listening, only when
  `rtEnabled()` (in browser mode the editor tab already keeps the sandbox awake).
- Broadcast watchdog state changes over the existing `onRtdbEvent` bus as a new event
  `{ type: "sandbox-status", ok: boolean }` so the HUD can display it (HUD rendering is
  out of scope for this prompt — just emit; extend the `RtdbBroadcastEvent` union).

**Acceptance.** Build passes. With the env var set to something short (e.g. 15000) and
the sandbox up, logs show periodic successful pings and no browser launches. Type union
extension compiles in the HUD (`cd voice-hud && npm run build`) — `handleRtdbEvent`
ignores unknown event types gracefully (verify it does; if it would throw, add a
default-ignore).

---

## Prompt 7 — HUD: take roster refresh off the agent's hot path

**Problem.** In `voice-hud/src/main.ts`, `runAgent()` does
`await refreshRoster({ silent: true })` **before** calling `agent.handle(...)`. Every
utterance pays a full `list_tokens` MCP round trip before the LLM even starts — and if
the relay is degraded that's up to 30 s of dead gem. There's also a second
`refreshRoster` after the turn, so the data is rebuilt twice per turn.

**Task.** In `voice-hud/src/main.ts`:

- In `runAgent`, replace the awaited pre-turn refresh with fire-and-forget **stale-while-
  revalidate**: kick `refreshRoster({ silent: true }).catch(…)` without awaiting, and
  proceed immediately with the roster the agent already has (set by the previous turn /
  startup). The agent's `setRoster` is already safe to call mid-stream only between
  turns — the un-awaited refresh may land mid-turn, so guard it: add a module-level
  `let _agentTurnActive = false;` set/cleared in `runAgent`'s try/finally, and in
  `refreshRoster`, if a turn is active, stash the built block in a
  `let _pendingRosterBlock: string | null` instead of calling `agent.setRoster`; apply
  it in `runAgent`'s `finally`.
- Keep the existing post-turn `refreshRoster` call (it picks up tokens the turn
  created) — it satisfies the next turn's freshness, which is exactly the SWR model.
- Startup behavior unchanged (the initial awaited `refreshRoster()` in `app.whenReady`
  stays).

**Acceptance.** `cd voice-hud && npm run build` passes. Speaking to the gem starts the
LLM turn immediately (log timestamps: `[agent] turn start` should no longer be preceded
by a roster build). Roster names still update across turns.

---

## Prompt 8 — Small perf + hygiene sweep

Batch of independent low-risk items:

1. **`rtFindTokenPage` campaign read cache** (`src/bridge/roll20-rt.ts`): every call
   does `rtGet("campaign")` (one RTT) just for `playerpageid`/`initiativepage`. Cache
   that pair module-level for 30 s (timestamp + value). Invalidate in `rtReconnect()`
   and on campaign switch (`getConn` already detects switches — clear there).
2. **Reject, don't clear, pending relays on navigation** (`src/bridge/roll20.ts:109`):
   `page.on("load", …)` currently does `pendingRelays.clear()`, leaving callers to hang
   until full timeout. Iterate and `reject(new Error("editor page navigated — relay
   interrupted"))` first, then clear. Read-only callers will fast-fail into their retry;
   writes fail loud immediately instead of after 30 s.
3. **`isLoggedIn` honesty** (`src/bridge/browser.ts`): the `catch` returns `true`
   ("assume session still good") on navigation failure, masking a dead network. Return
   `true` only if `page.url()` already matches the target site (we're plausibly there);
   otherwise re-throw so the caller surfaces a real connectivity error instead of
   cascading downstream timeouts.
4. **`seenKeys` LRU** (`src/bridge/roll20-rt.ts`): `if (size > 500) clear()` wholesale
   creates a brief window where replays double-process. Replace with insertion-order
   trim: `Set` iterates in insertion order, so delete the first ~100 keys instead of
   clearing.
5. **HUD: clear combat state on campaign switch** (`voice-hud/src/main.ts`):
   `combatPlans`, `combatCurrentId/Name`, `combatRound`, `inboxCount` persist across
   `switch_campaign`. There's no campaign-switch signal in the HUD today — acceptable
   proxy: in `refreshRoster`, if `readActiveSlug()` differs from `activeSlug`, update
   `activeSlug`, reload `campaignData`, and reset the combat-state module vars.

**Acceptance.** `npm run build`, `npx vitest run`, and `cd voice-hud && npm run build`
all pass. Each item is one focused commit (or one combined commit with all five —
implementer's choice).
