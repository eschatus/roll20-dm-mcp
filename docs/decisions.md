# Architecture Decision Log

This file records every non-obvious architectural choice made in this project. Each entry explains what was chosen, what the alternatives were, and why.

---

## 1. Playwright cookie sessions instead of D&D Beyond OAuth

**Choice:** Authenticate to D&D Beyond using the `cobalt` session cookie captured from a Playwright-driven browser login, rather than any OAuth flow.

**Why:** D&D Beyond does not expose a stable public API, and no OAuth endpoint grants programmatic access to character sheets from a server process. The `cobalt` cookie is the community-documented approach for server-side DDB automation. The same pattern is used by tools like `ddb-importer` and prior homebrew Beyond20 replacements.

**DDB is read-only.** All D&D Beyond write paths have been removed (`patchCharacter`, `applyCondition`, `ddb_update_hp`, and the DDB branches of `apply_damage` / `heal_character`). DDB condition writes returned 405 and HP writes were unreliable. Live HP and conditions are now written exclusively to the Roll20 token (see Trace 2 in `choreography.md`). The `cobalt` cookie is used only for read access: character/monster stat lookups and optional round-start drift checks.

**Trade-offs:** The `cobalt` cookie is a session token with full account access (read and, in principle, write). We never issue writes, but the cookie scope cannot be narrowed (see `security.md` §2). It must be stored securely. If D&D Beyond changes their auth system, read access breaks.

---

## 2. `userDataDir` session persistence in Playwright

**Choice:** Use `chromium.launchPersistentContext(userDataDir)` so sessions survive MCP server restarts, rather than logging in fresh each time.

**Why:** Login flows require 5–15 seconds and sometimes trigger CAPTCHA or 2FA on repeated automated logins. Persistent sessions avoid re-triggering these on every tool call.

**Trade-offs:** The `userDataDir` directory contains cookies for both roll20.net and dndbeyond.com. It is functionally equivalent to a password vault and must be protected accordingly (see `security.md`). The directory should **not** be in a cloud-synced folder.

---

## 3. Internal Claude Vision call for map analysis

**Choice:** The MCP server calls the Anthropic API internally during `analyze_battlemap` rather than exposing a raw "pass this image to Claude" tool.

**Why:** This gives Claude (the DM assistant) a single tool call that says "analyze this map" and gets back structured JSON (grid size, wall segments). The alternative — exposing the image analysis as a two-step conversation turn — would require the assistant to manage the intermediate state. Inlining it is a cleaner UX.

**Trade-offs:** The image analysis happens opaquely inside a single tool invocation. If the Vision call fails, the error surfaces as a tool error. The DM cannot inspect or redirect the Vision prompt. This is an intentional design: we want the tool to be reliable and opaque, not flexible and fragile.

---

## 4. Character registry as a local JSON file

**Choice:** `data/characters.json` — a flat JSON map from character name to `{ roll20TokenId, ddbCharId }` — rather than a database (SQLite, etc.).

**Why:** Single-machine tool. The DM runs this locally. There are ~5 PCs per campaign. A JSON file is readable, diffable, and requires zero setup. A database would add complexity with no benefit at this scale.

**Trade-offs:** Single-machine only. If the MCP server were ever deployed remotely or shared across DMs, the registry would need to become a proper store.

---

## 5. Character attribute relay (GM_AI_Bridge) over handout relay

**Choice:** Store the command queue in a Roll20 campaign attribute (`GM_AI_Bridge_cmd` / `GM_AI_Bridge_result`) rather than in a Roll20 handout.

**Why:** Campaign attribute `change:` events fire synchronously within the Roll20 Mod sandbox. Handout polling runs on a timer and adds ~500ms of round-trip latency per command.

**Trade-offs:** Campaign attributes with empty `characterid` are an undocumented but stable feature of Roll20's data model. Handouts would be more visible and editable but slower.

> **SUPERSEDED — transport is now chat-command driven.** The attribute-queue (`change:attribute` on `GM_AI_Bridge_cmd` / `GM_AI_Bridge_result`) has been replaced by a `!ai-relay {JSON}` chat command: the MCP server types the command into Roll20 chat, the relay handles it on `chat:message`, and the result is whispered back as a hidden `/w gm` div read by a MutationObserver. State that needs to persist across sandbox restarts lives in `state.GM_AI_Bridge` (see `docs/roll20-api-coverage.md`), not in attributes. Because chat is a player-writable channel, authorization is enforced by a GM-only sender check (`playerIsGM`) in the handler — see `security.md` §6.

---

## 6. Single-slot command queue

**Choice:** The relay uses a single `cmd`/`result` attribute pair (one command at a time) rather than a ring buffer or numbered queue.

**Why:** MCP tool calls are sequential — Claude cannot issue two tool calls in parallel within a single turn. The serial model matches how the MCP server actually uses the relay.

**Trade-offs:** If the relay is ever called from two parallel processes (e.g., a second MCP client), commands will overwrite each other. A nonce-based check catches stale results but does not prevent queue clobbering. This would need a ring buffer if parallel callers become a real use case.

---

## 7. Zod validation at the MCP tool layer

**Choice:** All tool inputs are validated by Zod schemas before any browser or API interaction.

**Why:** Roll20 and DDB API errors surface as cryptic Playwright exceptions or 4xx responses. Zod lets us fail fast with a readable message before touching any browser state. It also prevents accidental injection via malformed inputs.

**Trade-offs:** None worth noting at this scale.

---

## 8. Roll20 status marker ↔ D&D Beyond condition mapping table

**Choice:** A hardcoded condition→tag mapping, kept in three hand-synced copies — `CONDITION_MARKERS` in `src/tools/combat.ts` (an array, used by `get_token_markers` for the RESERVED palette), in `src/bridge/markers.ts` (a Record, used by the RT path's `resolveMarkerForState`), and in `mod-scripts/ai-relay.js` (the Mod sandbox copy) — maps condition names (`poisoned`, `blinded`, etc.) to this campaign's **custom** Roll20 status-marker tags (`Poisoned::4444329`, `Blinded::4444318`, etc.). ⚠️ The three copies are NOT identical: `combat.ts` folds `wounded` into `CONDITION_MARKERS`, whereas `markers.ts` and `ai-relay.js` place `wounded`/`bloodied` in `PSEUDO_MARKERS` (so a "clear all conditions" sweep treats `wounded` as a condition via the `combat.ts` table but as a non-swept pseudo via the others — keep this in mind when editing).

**Why:** The two systems use incompatible vocabularies, and the campaign uses an uploaded custom marker set — the default Roll20 icons (`skull`, `bleeding-eye`) and ad-hoc hashes render *nothing* on these tokens. The table therefore encodes the campaign-specific `Name::id` tags directly. Name resolution is three-tier (`resolveMarkerForState`: `CONDITION_MARKERS` → `PSEUDO_MARKERS` → hashed ad-hoc pool), so any state name renders something. See `docs/roll20-token-markers.md` for the full palette.

**Trade-offs:** The tags are specific to this campaign's uploaded marker set (IDs 4444311–4444352, shared across the DM's campaigns). A campaign without that set would need its own `token_markers` IDs substituted. There are three copies of the table (TS tool, TS bridge, Mod sandbox) that must be kept in sync by hand — the Mod can't import the TS module.

---

## 9. Campaign registry + persisted active campaign

**Choice:** Store all campaigns in `data/campaigns.json` (a named slug → `{ roll20CampaignId, ddbCampaignId }` map). The active campaign is persisted to `data/active-campaign.json` by `setActiveCampaign` and restored on startup by `restoreActiveCampaign` (in `src/registry/campaigns.ts`). The character registry is partitioned by campaign slug.

**Why:** The DM runs 13+ campaigns. A single `.env` variable for campaign ID only works for one. Campaigns are long-lived (months/years) so they persist in a file. The active campaign was *originally* in-memory (reset on restart), but that meant a mid-session server restart silently dropped the active campaign and the next tool could touch the wrong one. Persisting it to `active-campaign.json` survives restarts, so the DM does not have to re-`switch_campaign` after every restart.

**Trade-offs:**
- The active campaign now persists across restarts. The `switch_campaign`-then-wait rule (see `skills/dm-rules.md`) still applies for *intentional* switches, but a restart no longer requires a re-switch.
- The Roll20 editor page lazily navigates to the active campaign's URL on the next tool call that needs the browser (when `_loadedCampaignId` mismatches) — not inside `setActiveCampaign` itself. This takes ~5–10 seconds but only happens once per switch.
- `data/campaigns.json`, `data/characters.json`, and `data/active-campaign.json` are written atomically (write-temp-then-rename) to survive concurrent readers; back up the first two — they're the DM's work, not derivable from Roll20 or DDB.

---

## 10. Deferred: `ai-relay.js` dispatch-switch → handler-map refactor

**Known smell:** `mod-scripts/ai-relay.js` dispatches every relay command through a single ~1,300-line `switch (action)` statement. A handler-map refactor (one function per action, registered in a lookup table) would shrink the file and make each action independently testable.

**Decision:** This refactor is **DEFERRED** until a relay test/replay harness exists. The relay runs inside the Roll20 Mod sandbox, which has no local test runner; the only current way to validate a change is to deploy it into a live campaign and exercise it by hand. Refactoring 1,300 lines of dispatch logic with no automated regression net is high-risk for a cosmetic gain. Build the harness (record real `!ai-relay {JSON}` commands + expected token mutations, replay them against the handler functions) first; do the handler-map split second.

> Note: a `test/relay-actions.test.ts` harness now exists (a Roll20 emulator exercising `ai-relay.js` pure helpers), partially satisfying the precondition. The handler-map split is still deferred.

---

## 11. Browserless Firebase RTDB transport (the default; opt OUT via `ROLL20_TRANSPORT=browser`)

**Choice:** Use a browserless Firebase Realtime Database transport as the **default**. `rtEnabled()` is true unless `ROLL20_TRANSPORT=browser` (i.e. unset → RT). The MCP server harvests Roll20's per-campaign Firebase custom token (intercepted from the browser's `signInWithCustomToken` request, cached in `data/roll20-rt-token.json`, TTL ~50 min), then pushes `!ai-relay {JSON}` commands into the campaign's RTDB chat node and reads `AIBRIDGE_RESULT` back over an RTDB child listener. The legacy Playwright browser→chat relay is now a dev opt-out reachable only under `ROLL20_TRANSPORT=browser`.

**Why:** The Playwright chat-typing path is slow (~hundreds of ms) and requires a live browser window per command. RTDB is shard-aware and warm-path ~49ms. Critically, a packaged install ships no Playwright, so combat must be browserless and an RT failure must **surface** (prompting a token re-harvest in the gem) rather than silently reaching for a Chromium that isn't there. The combat RT relay therefore has **no Playwright fallback** — `relayCommand`'s RT branch (`src/bridge/roll20.ts`) re-throws on failure. The Mod handles every action regardless of transport, so RT serves reads and mutating writes alike.

**Trade-offs:** Adds Firebase token harvesting + refresh complexity and a second transport to reason about. The same-nonce idempotency mechanism (a shared nonce generated once per command and reused on retry, deduplicated by the Mod's `PROCESSED_NONCES` LRU) is what makes a retry safe to re-issue without double-applying — but on the default RT path there is no cross-transport fallback, so that machinery only matters for the `=browser` path's own internal retries. A circuit breaker (`circuitOpen` in `src/bridge/transport-health.ts`: opens after 3 consecutive failures, with a 30s reset/probe window) fast-fails RT calls while it's known-down instead of paying the timeout each time. See `docs/roll20-realtime-protocol.md`.

---

## 12. In-process SSE for HUD delivery (mob plans + DM inbox), not RTDB writes

**Choice:** Deliver Voice-HUD payloads (tactical mob-plan cards, `!dm` inbox items) to the HUD via an in-process Server-Sent Events broadcast from the HTTP server, rather than writing them to a custom `aibridge/*` RTDB subtree for the HUD to read.

**Why:** Reverse-engineering showed Roll20's RTDB security rules **deny client writes to `aibridge/*` on every shard** (verified on `roll20-99910` and `roll20-99922`). The HUD therefore cannot read DM-authored data from a custom RTDB path, and the Mod has no Firebase access to write one. An in-process SSE stream (`/events` on the HTTP server, `src/index-http.ts`) sidesteps the denied channel entirely: the server already holds the data, so it broadcasts directly to connected HUD clients.

**Trade-offs:** SSE delivery is local to the machine running the MCP server — fine for the single-DM, single-machine deployment model (see Decision 4). It would need a real message bus if the HUD ever ran on a different host than the server.

---

## 13. Atomic writes for registry files

**Choice:** `data/campaigns.json`, `data/characters.json`, and `data/active-campaign.json` are written via write-to-temp-then-rename, not in-place truncate-and-write.

**Why:** The MCP server and recon scripts can read these files while a tool is mid-write. An in-place write exposes a window where a reader sees a truncated/partial JSON file and crashes on parse. Rename is atomic on the same filesystem, so a reader always sees either the old or the new complete file.

**Trade-offs:** None worth noting; the temp file lands in the same directory so the rename stays atomic.

---

## 14. Mod deploy must run through the warm server page (the duplicate-relay incident)

**What happened:** a one-command `release:mod` (deploy + soak from a fresh `tsx` process) **created a second relay script** in the Roll20 API console, which jammed the sandbox (two `chat:message` handlers) and took the live relay down.

**Root cause:** `deployModScript` matches the existing `ai-relay.js` tab by reading `#scriptorder`. The MCP server reuses a *warm* `_modPage` where those tabs are already rendered; a fresh process navigated with `waitUntil: "domcontentloaded"` and queried the tabs **before Roll20's JS rendered them** → "no existing tab" → the create-new-script branch → duplicate.

**Fixes (all landed):**
- `getModPage` now `waitForSelector('#scriptorder a[data-toggle="tab"]')` after navigation, so callers never inspect tabs early.
- `deployModScript(campaignId, path, { requireExisting: true })` refuses to create a new tab — a release can only ever *overwrite*. `release:mod` passes it (belt-and-suspenders).
- `release:mod` runs the soak **in-process** (`runSoak()` from `soak-test.ts`), not as a child: a child can't share the persistent browser profile (so it can't bootstrap RT) and a second RT listener collides — both false-fail the soak. It also waits a fixed settle for the rebooted sandbox to warm before soaking.

**Lesson:** anything touching the API editor must go through the server's warm page (or wait for tabs), and live verification (soak) must share the one browser/RT connection.
