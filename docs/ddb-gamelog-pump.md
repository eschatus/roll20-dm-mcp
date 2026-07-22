# D&D Beyond roll pump → Roll20 chat

Pumps a D&D Beyond character's **live dice rolls** into Roll20 chat. Built for the
**orphaned-character** case: a PC whose player rolls on D&D Beyond but has no Beyond20
bridge, so their rolls never reach the VTT (e.g. Broo Zbaaner, DDB entity `130003005`,
in game `1117568`). Fully browserless — reuses the same cobalt→JWT the other DDB reads use.

## Transport (all verified live; spikes in `src/recon/ddb-gamelog-*.ts`)

```
JWT (auth-service/cobalt-token, ~300s ttl, same as character-service reads)
 │  Bearer                                    │  stt=<JWT> query param
 ▼                                            ▼
REST backfill (dedup seed)                    WebSocket (live push)
game-log-rest-live.dndbeyond.com              wss://game-log-api-live.dndbeyond.com
  /v1/getmessages?gameId=&userId=               /v1?gameId=&userId=&stt=
```

- **Bearer authorizes; cookie/none get 401** ("token missing"). Proven browserless.
- The WS pushes each event as one JSON frame; we keep `eventType === "dice/roll/fulfilled"`.
- `userId` is the JWT's `nameidentifier` claim (`rtAuthToken()` in `ddb-rt.ts`).

## Message shape (only what we consume)

```jsonc
{
  "id": "<uuid>",                    // dedup key
  "dateTime": "1784681529261",       // epoch ms (string)
  "entityId": "130003005",           // the rolling character → the filter key
  "eventType": "dice/roll/fulfilled",
  "data": {
    "action": "Elemental Cleaver",   // header
    "context": { "name": "Broo Zbaaner" },   // speaker
    "rolls": [{
      "rollType": "Force",
      "diceNotationStr": "5d8",       // OFTEN ABSENT — reconstruct from diceNotation
      "diceNotation": { "constant": 0, "set": [{ "count": 5, "dieType": "d8" }] },
      "result": { "total": 25, "text": "7+1+5+8+4", "values": [7,1,5,8,4] }
    }]
  }
}
```

## Beyond20 failover (the default mode)

Beyond20 sets `data.__b20Override__: true` on every roll it bridges to the VTT — i.e.
rolls that ALREADY reached Roll20. Verified live across three games: players on
Beyond20 carry it on every roll; players rolling in the native DDB tray never do; a
flaky bridge yields a mix (e.g. one 8th-St player: 6 bridged, 2 dropped).

So the pump SKIPS `__b20Override__` rolls by default (`skipBeyond20`, exposed on the
tool as `includeBeyond20:false`). That makes it a **gap-filler**, not a mirror:

- A working Beyond20 → flagged → skipped. Only its *failures* come through.
- A flapping bridge → its dropped rolls post, its delivered ones don't. No manual
  start/stop needed.
- Safe to arm **table-wide** (omit `characterNames`): only the orphaned rolls — the
  exact ones missing from Roll20 — get posted.

Set `includeBeyond20:true` to mirror every roll regardless (will double-post anything
Beyond20 also delivered — rarely wanted).

## Mirror, never re-roll

DDB has already determined the dice. A fresh Roll20 `/roll` would invent **different**
numbers, so the pump renders the *actual* values as a `&{template:default}` card — plain
text only, no `[[…]]` inline-roll syntax (Roll20 would re-roll that). Result:

```
Broo Zbaaner:
  &{template:default} {{name=Elemental Cleaver — via D&D Beyond}}
    {{Force 5d8 = 25 (7+1+5+8+4)}} {{Bludgeoning 4d6 + 5 = 18 (2+2+5+4+5)}}
```

Rendering is pinned by `src/bridge/ddb-gamelog.test.ts`.

## Pieces

| File | Role |
|---|---|
| `src/bridge/ddb-rt.ts` `rtAuthToken()` | fresh JWT + userId for the WS `stt` |
| `src/bridge/ddb-gamelog.ts` | `DdbGameLogPump` (WS + reconnect + dedup) and `renderRollForRoll20` |
| `src/tools/ddbPump.ts` | `start_ddb_roll_pump` / `stop_ddb_roll_pump` / `ddb_roll_pump_status` |
| `mod-scripts/ai-relay.js` `postChat` | posts the raw template string as the character |

The pump reconnects with a fresh JWT ~40s before the token lapses, and on any abnormal
close (observed `1006`) with backoff. The dedup set is seeded from REST history on start
so a reconnect's replay never double-posts.

## Going live (the write side)

The read side is proven end-to-end. To make rolls actually appear in Roll20:

1. **Deploy the `postChat` relay action** to the table's Roll20 game: `npm run release:mod`
   (the running Mod predates `postChat`; without it the pump reads but can't write).
2. **Active campaign = the table's Roll20 game**, so the relay writes there. For Broo that's
   the PSK campaign (Roll20 `17883742`, DDB `1117568`). Restart `npm run serve` to pick up
   the new tools.
3. `start_ddb_roll_pump({ characterNames: ["Broo Zbaaner"] })` — omit `characterNames` to
   relay every character. `stop_ddb_roll_pump` to end; `ddb_roll_pump_status` to check.

## Known / future

- **WS-only push** — the game log only pushes NEW events; history is REST. The pump seeds
  dedup from REST but does not backfill-post old rolls (by design).
- **Realtime-only tuning** — no safety poll; if the WS silently wedged between reconnects a
  roll could be missed. A low-frequency `getmessages` reconciler is the obvious hardening.
- **Speaker fidelity** — posts under the character's *name* (`speakAs`), not its Roll20
  character sheet, so no avatar. Mapping DDB entity → Roll20 character for the avatar is a
  future nicety.
