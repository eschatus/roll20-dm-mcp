# Roll20 realtime transport — reverse-engineering notes

Captured 2026-06-05 via a read-only recon script (since retired; the surviving RTDB probes are
`src/recon/rtdb-schema.ts`, `rt-reads.ts`, `rt-roundtrip.ts`, `ping-probe.ts`). Nothing was modified
in the campaign. Goal: replace the Playwright chat-typing relay with a browserless client that injects
the `!ai-relay` chat message and reads the `AIBRIDGE_RESULT` whisper back — **keeping
`mod-scripts/ai-relay.js` unchanged.** This build is Roll20's "jumpgate" editor.

## STATUS: ✅ VALIDATED end-to-end (2026-06-05); the ONLY transport since 2026-08-26

Implemented in `src/bridge/roll20-rt.ts`. **RT is the only transport** — the legacy Playwright
browser→chat relay and `CLIENT_READS` were deleted in #122/#179, so `ROLL20_TRANSPORT=browser`
selects nothing and there is no fallback of any kind. An RT failure surfaces as a thrown error
naming the fix. Live round-trip confirmed: **~420ms cold / ~49ms warm**. The Mod script, its relay
actions, and the `AIBRIDGE_RESULT` protocol are unchanged.

Roll20's tabletop state and chat live in a **Firebase Realtime Database**. The Mod sandbox reacts
to `on("chat:message")`. Chat is written **exclusively over Firebase** (confirmed: no chat XHR
endpoint). A Node client authenticated to the same RTDB:

1. **pushes** a child to `/<storagePath>/chat` with `content:"!ai-relay {…}"` **in the exact shape
   the UI uses** (see below — `type:"api"` + a distinct `messageId` + `.priority` server timestamp;
   omitting `messageId`/`.priority` writes the child but the Mod never fires) → Mod runs as normal.
2. **listens** on `/<storagePath>/chat` (onChildAdded) → the Mod's `AIBRIDGE_RESULT:` whisper
   arrives as a live `/chat` child and is parsed exactly like the old `OBSERVER_SCRIPT`.

> Gotcha that cost us time: the relay only validates when the **API/Mod sandbox is actually alive**.
> A wedged sandbox (e.g. the undefined→Firebase crash — see `CLAUDE.md`'s `setSafe` rule) times out
> exactly like a dead transport; it is not a transport bug, and back when there were two transports
> both failed identically, which is how we know. Restart the sandbox (API console → Save Script)
> before suspecting the client. `transport_status` and the `ping` version echo tell them apart.

## Firebase project (public web config — safe to record)

```
apiKey:      AIzaSyDSuyx7vpT7ZS0EdeX68qVKIQKv9MfSQN0   (public web key, embeddable)
authDomain:  roll20-dev.firebaseapp.com
databaseURL: https://roll20-99910.firebaseio.com/
projectId:   roll20-dev
appId:       1:717330860670:web:8bd50673cd0a383f4b662f
```

WebSocket actually observed (Firebase redirects the base host to a regional shard):
`wss://s-gke-usc1-nssi2-42.firebaseio.com/.ws?v=5&p=<appId>&ns=roll20-99910`

## Auth chain (what we actually implemented)

**Correction to an early assumption:** `POST /editor/oauth_token` returns a *Roll20 OAuth* token
(`access_token`, single dot) — it is **NOT** the Firebase custom token. The Firebase **custom
token** (a real 3-segment JWT) is minted opaquely by the editor bootstrap and handed straight to
`signInWithCustomToken`; we could not pin a standalone endpoint that returns it.

Chosen approach: **capture the custom token once in a logged-in first-party session**, then operate
over the socket. **Since #177 this server does NOT do the capture** — it reads a furnished
credential and never mints one:

1. **Harvest (elsewhere — the gem, human present).** Load `/editor/setcampaign/<id>/` in the gem's
   own logged-in Electron browser and **intercept the `signInWithCustomToken` request body** to
   capture the custom token. The modular SDK only fires that call on a *fresh* auth, so if the
   editor restored from IndexedDB, `firebaseLocalStorageDb` is deleted and the page reloaded to
   force a fresh sign-in. The harvester writes `<data dir>/roll20-rt-token.json`
   (`{campaignId, customToken, databaseURL, harvestedAt}`).
2. **Read (here).** `getCustomToken` in `roll20-rt.ts` reads that file and validates three things —
   it is for **this** campaign (tokens are campaign-scoped), it carries a `databaseURL` (pre-shard-
   fix caches don't, and would reconnect to the wrong shard), and it is inside the max age. Any miss
   throws `Roll20TokenUnavailableError` naming which of the three failed. **There is no harvest
   fallback**: an unattended MCP server must not be able to drive a browser against a live account
   (#177, sibling of #175/#83).
3. Feed that custom token to the Node `firebase` SDK's `signInWithCustomToken` → the SDK gets the
   Firebase **ID token** and **auto-refreshes** it for the whole process lifetime (~1h tokens). So a
   long session only needs the custom token to be fresh at connect time.

ID-token claims (read via `getIdTokenResult()`, no manual JWT decode):
`{ currentcampaign:"campaign-<id>-<key>", is_gm:true, playerid, userid, … exp≈+1h }`.
`currentcampaign` = the `<storagePath>`; `playerid`/`userid` populate the chat-write fields.

> Live token VALUES are intentionally NOT recorded here. Treat them as secrets.
> Longer-lived-credential follow-up (still not done, and now lower value): persist the firebase
> refresh token and refresh ID tokens via `securetoken.googleapis.com` — but the official Auth SDK
> has no Node API to ingest a raw refresh/ID token, so that path requires the zero-dep raw-wire
> client instead of the SDK. It would extend how long a furnished credential stays usable; it would
> not change *who* mints it, which is the point of #177.

## Firebase RTDB wire protocol (as observed)

Frames are JSON. `t:"c"` = control, `t:"d"` = data. Data envelope: `{t:"d",d:{r:<reqId>,a:<action>,b:<body>}}`.

Handshake (in order):
```
recv {"t":"c","d":{"t":"h","d":{ ts, v:"5", h:<shardHost>, s:<sessionId> }}}   # server hello
sent {"t":"d","d":{"r":1,"a":"s","b":{"c":{ "sdk.js…":1 }}}}                    # stats (optional)
sent {"t":"d","d":{"r":2,"a":"auth","b":{"cred":"<Firebase ID token>"}}}        # AUTH
recv {"t":"d","d":{"r":2,"b":{"s":"ok","d":{auth:{ is_gm:true, playerid, userid, … }}}}}
sent {"t":"d","d":{"r":3,"a":"q","b":{"p":"/campaign-<id>-<key>/broadcast","h":""}}}  # listen
```

Listen on chat (the browser used a limited query):
```
sent {"t":"d","d":{"r":N,"a":"q","b":{"p":"/campaign-<id>-<key>/chat","q":{"l":100,"vf":"r"},"t":1,"h":""}}}
```
- `a:"q"` = listen/subscribe. `q:{l:100,vf:"r"}` = limitToLast 100. Initial response is the current
  window; subsequent pushes arrive as `{a:"d"|"m", b:{p,d}}` (`d`=overwrite, `m`=merge).

Action codes seen / needed:
- `s` stats · `auth` authenticate · `q` listen · `p` put(set) · `m` merge(update) · `o`/`n` unlisten
- keepalive: client sends `0`-length ping frames (~45 s) — the SDK handles this.

### Chat message shape (captured from a live UI send — replicate EXACTLY)

Write to `/<storagePath>/chat/<pushKey>`:
```json
{
  "avatar": "/users/avatar/<userid>/30",
  "content": "!ai-relay {\"action\":\"…\",\"nonce\":…}",
  "messageId": "<a SECOND, distinct push id>",   // NOT the same as <pushKey> — generate separately
  "playerid": "<our playerid, e.g. -OkAL…>",
  "type": "api",                                  // "api" for ! commands; "general" for plain chat
  "who": "DM (GM)",
  ".priority": { ".sv": "timestamp" }             // server timestamp sentinel (firebase serverTimestamp())
}
```
`messageId` + `.priority` are **load-bearing**: without them the child is written but Roll20's chat
processor treats it as replayed history and the Mod never fires. (We generate `messageId` via a
second `push(chatRef).key` and set `.priority` via `serverTimestamp()`.)

**The Mod's response** comes back as a live `/chat` child: `who:"GM-AI-Bridge"`,
`content:"<div style='display:none'>AIBRIDGE_RESULT:{json}</div>"`. It's sent `noarchive:true`, so
it's delivered to connected clients but **never persisted** (that's why it's absent from chat
history). `onChildAdded` catches it in real time; scan `content` for the `AIBRIDGE_RESULT:` marker +
balanced-brace JSON, then match `nonce`. (The `/broadcast` path carries *other* transient UI events
— ruler/`measureData`, etc. — and is NOT needed for relay results.)

`<storagePath>` = `campaign-<roll20CampaignId>-<key>` (the `currentcampaign` claim). The trailing
key is per-campaign; read it from the ID-token claims at connect time, not derivable from the id.

## Secondary socket (ignore)

`wss://signal2.roll20.net:4001/socket/websocket` — a Phoenix/Elixir channels socket (presence/
signaling). Not used for chat or object state; irrelevant to the relay.

## Chosen direction: socket transport, keep Mod  ✅ IMPLEMENTED

This was the plan; it shipped. Current state:

- `src/bridge/roll20-rt.ts` backs `relayCommand` (`roll20.ts` is now just the dispatcher + the
  circuit-breaker gate + the art-upload POST). **RT never falls back to anything** — an RT failure
  re-throws a clear "reconnect Roll20 in the gem to re-harvest the token" error. A circuit breaker
  (`circuitOpen` in `src/bridge/transport-health.ts`: 3 consecutive failures, 30s reset/probe
  window) fast-fails RT calls while it is known-down rather than paying the full timeout each time;
  `transport_status` reports it.
- Direct reads bypass the Mod entirely: `rtGet`/`tryDirectRead` reads the campaign storage subtree —
  tokens at `<storagePath>/graphics/page/<pid>`, paths at `paths/page/<pageId>`, doors/windows at
  `doors|windows/page/<pageId>`, and the page list at top-level `pages` (serving `listPages`,
  `getTokens`, `getTokenById`, `getTurnOrder`, `getTokenMarkers`, `getPaths`, `getDoors`) — falling
  back to the Mod relay on error. (`CLIENT_READS`, which served some of these off a live browser's
  Backbone models, is deleted along with the browser.)
- **Writes** go over RTDB too, in two flavours: everything the Mod owns travels as an `!ai-relay`
  chat child, but page *creation* is a direct RTDB write (`rtCreatePage`, #178) — `createObj("page")`
  is a **Mod sandbox** limitation that never applied to this path. Note `width`/`height` there are
  70px **units**, not cells.
- Token refresh: the Firebase SDK auto-refreshes the ID token for the process lifetime; the custom
  token is not refreshed here at all — it is furnished, validated, and rejected when stale.
- D&D Beyond is no longer part of this repo — the bridge and its protocol notes moved to **beyond-mcp**
  with the code (#171 Phase 2).

## Map pings: the `broadcast` channel (discovered 2026-06-11 by frame-sniffing)

Shift+click map pings transit the campaign RTDB as a **put to
`<storagePath>/broadcast`** — a single-value channel overwritten on every ping
(not a push list). Payload is a JSON *string*:

```json
{"type":"ping","data":{"position":{"x":938.5,"y":-680.0},"focus":false,
 "page":"<pageid>","player":"<playerid>","ts":1781207868473}}
```

- `position` is page pixels with Roll20's negated-y canvas convention (same as
  door objects); negate y to get normal page coordinates.
- `focus` distinguishes plain ping from ping-and-pull-view.
- Holding the ping emits a fresh put every ~2s.
- Readable with our existing custom-token auth — `parseBroadcastPing`
  (rt-helpers.ts) + an `onValue` in `startRtdbSubscriptions` feed
  `getLastPing()`, which powers `resolve_aoe atPing:true` ("fireball where I
  pinged"). Note: the name-guess probe (src/recon/ping-probe.ts) found rules are
  default-deny per path — root listing is 401, so unknown node names can only be
  found by sniffing frames, not guessing.
