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

**Choice:** A hardcoded mapping in `src/tools/combat.ts` maps DDB condition names (`poisoned`, `blinded`, etc.) to Roll20 status marker strings (`skull`, `bleeding-eye`, etc.).

**Why:** The two systems use incompatible vocabularies. Roll20 status markers are short visual identifiers; DDB conditions are semantic names. There is no official mapping between them — this is a judgment call based on visual convention.

**Trade-offs:** Roll20 lets GMs customize marker sets. If the campaign uses a custom marker set, these strings may not match. The mapping can be overridden by editing `CONDITION_TO_MARKER` in `combat.ts`.

---

## 9. Campaign registry + in-memory active campaign

**Choice:** Store all campaigns in `data/campaigns.json` (a named slug → `{ roll20CampaignId, ddbCampaignId }` map). Active campaign is an in-memory variable set by `switch_campaign`. The character registry is partitioned by campaign slug.

**Why:** The DM runs 13 campaigns. A single `.env` variable for campaign ID only works for one. Campaigns are long-lived (months/years) so they need to persist across server restarts in a file. But the *active* campaign is a session concept — the DM says "switch to Strahd" before a session, it stays active for that session, and resets on the next restart to whatever is called first.

**Trade-offs:**
- The active campaign resets on MCP server restart — the DM must call `switch_campaign` once at the start of each session. This is intentional: it prevents accidentally updating the wrong campaign's tokens after a restart.
- The Roll20 editor page navigates to the new campaign URL when `switch_campaign` is called (on the next tool call that needs the browser). This takes ~5–10 seconds but only happens once per switch.
- `data/campaigns.json` and `data/characters.json` should be backed up — they're the DM's work, not derivable from Roll20 or DDB.

---

## 10. Deferred: `ai-relay.js` dispatch-switch → handler-map refactor

**Known smell:** `mod-scripts/ai-relay.js` dispatches every relay command through a single ~1,300-line `switch (action)` statement. A handler-map refactor (one function per action, registered in a lookup table) would shrink the file and make each action independently testable.

**Decision:** This refactor is **DEFERRED** until a relay test/replay harness exists. The relay runs inside the Roll20 Mod sandbox, which has no local test runner; the only current way to validate a change is to deploy it into a live campaign and exercise it by hand. Refactoring 1,300 lines of dispatch logic with no automated regression net is high-risk for a cosmetic gain. Build the harness (record real `!ai-relay {JSON}` commands + expected token mutations, replay them against the handler functions) first; do the handler-map split second.
