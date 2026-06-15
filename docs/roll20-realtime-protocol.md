# Roll20 realtime transport — reverse-engineering notes

Captured 2026-06-05 via `src/recon/roll20-protocol.ts` (read-only; nothing modified in the
campaign). Goal: replace the Playwright chat-typing relay with a browserless client that injects
the `!ai-relay` chat message and reads the `AIBRIDGE_RESULT` whisper back — **keeping
`mod-scripts/ai-relay.js` unchanged.** This build is Roll20's "jumpgate" editor.

## STATUS: ✅ VALIDATED end-to-end (2026-06-05)

Implemented in `src/bridge/roll20-rt.ts`, behind `ROLL20_TRANSPORT=rt` with automatic Playwright
fallback. Live round-trip confirmed: **~420ms cold / ~49ms warm** (vs. the much slower chat-typing
relay). The Mod script, all ~40 relay actions, and the `AIBRIDGE_RESULT` protocol are unchanged.

Roll20's tabletop state and chat live in a **Firebase Realtime Database**. The Mod sandbox reacts
to `on("chat:message")`. Chat is written **exclusively over Firebase** (confirmed: no chat XHR
endpoint). A Node client authenticated to the same RTDB:

1. **pushes** a child to `/<storagePath>/chat` with `content:"!ai-relay {…}"` **in the exact shape
   the UI uses** (see below — `type:"api"` + a distinct `messageId` + `.priority` server timestamp;
   omitting `messageId`/`.priority` writes the child but the Mod never fires) → Mod runs as normal.
2. **listens** on `/<storagePath>/chat` (onChildAdded) → the Mod's `AIBRIDGE_RESULT:` whisper
   arrives as a live `/chat` child and is parsed exactly like the old `OBSERVER_SCRIPT`.

> Gotcha that cost us time: the relay only validates when the **API/Mod sandbox is actually alive**.
> A wedged sandbox (e.g. the [undefined→Firebase crash](relay-undefined-firebase-crash.md)) makes
> BOTH the browser relay and RT time out identically — it is not a transport bug. Restart the
> sandbox (API console → Save Script) before suspecting the client.

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

Chosen approach (see `getCustomToken`/`harvestCustomToken` in roll20-rt.ts): **harvest the custom
token once via the browser**, then operate over the socket:
1. Load `/editor/setcampaign/<id>/` in the persistent (logged-in) browser and **intercept the
   `signInWithCustomToken` request body** to capture the custom token. The modular SDK only fires
   that call on a *fresh* auth, so if the editor restored from IndexedDB we delete
   `firebaseLocalStorageDb` and reload to force a fresh sign-in.
2. Feed that custom token to the Node `firebase` SDK's `signInWithCustomToken` → the SDK gets the
   Firebase **ID token** and **auto-refreshes** it for the whole process lifetime (~1h tokens).
3. Cache the custom token to `data/roll20-rt-token.json` (<50 min) so quick restarts skip the
   browser; a cold start past the window touches Chromium once, then runs fully on the socket.

ID-token claims (read via `getIdTokenResult()`, no manual JWT decode):
`{ currentcampaign:"campaign-<id>-<key>", is_gm:true, playerid, userid, … exp≈+1h }`.
`currentcampaign` = the `<storagePath>`; `playerid`/`userid` populate the chat-write fields.

> Live token VALUES are intentionally NOT recorded here. Treat them as secrets.
> Fully-browserless follow-up (not done): persist the firebase refresh token and refresh ID tokens
> via `securetoken.googleapis.com` — but the official Auth SDK has no Node API to ingest a raw
> refresh/ID token, so that path requires the zero-dep raw-wire client instead of the SDK.

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

## Recommended build (chosen direction: socket transport, keep Mod)

- New `src/bridge/roll20-rt.ts` implementing the same `relayCommand` interface as `roll20.ts`,
  backed by an authenticated RTDB connection. Keep Playwright `roll20.ts` as a fallback transport
  behind a flag, so a Roll20 frontend change can't fully brick the relay.
- Client-direct reads (`CLIENT_READS` in roll20.ts) become RTDB reads of
  `/<storagePath>/pages/<pageId>/…` instead of Backbone — map those paths in a follow-up capture.
- Token refresh loop (~55 min) via securetoken endpoint.
- DDB is separately ~90% browserless already (CobaltSession bearer) — do it after.

## Map pings: the `broadcast` channel (discovered 2026-06-11, src/recon/ping-sniff.ts)

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
