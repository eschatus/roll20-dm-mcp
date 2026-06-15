// GM_AI_Bridge — Roll20 Mod relay script
// Deploy this in your campaign's Mod (API) editor under Settings > API Scripts.
//
// No setup required — the MCP server sends commands via !ai-relay chat commands,
// and results are written back to Campaign properties.

// Results are whispered to GM, wrapped in a CSS-targetable div so the campaign
// stylesheet can hide or style them without touching legitimate whispers.
function writeResult(nonce, data, error) {
  // Remember this nonce's outcome so a replayed (same-nonce) command echoes it
  // instead of re-running a mutating action. recordNonceResult is hoisted.
  recordNonceResult(nonce, error ? undefined : data, error ? String(error) : undefined);
  const payload = error
    ? JSON.stringify({ nonce, error: String(error) })
    : JSON.stringify({ nonce, data });
  // noarchive: won't appear in the persistent chat log.
  // display:none: hides any transient flash in the current session.
  // Playwright still reads textContent from hidden DOM elements.
  sendChat("GM-AI-Bridge",
    "/w gm <div style='display:none'>AIBRIDGE_RESULT:" + payload + "</div>",
    null,
    { noarchive: true }
  );
}

// HTML-escape any player-derived string before interpolating it into sendChat HTML.
// Prevents player-authored who/content/intent text from injecting markup into our cards.
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// True iff the message sender is a GM. Uses playerIsGM when present (it is in the
// Roll20 Mod API), else falls back to comparing against the campaign GM list.
function senderIsGM(playerId) {
  if (!playerId) return false;
  if (typeof playerIsGM === "function") {
    try { return playerIsGM(playerId); } catch (e) { /* fall through */ }
  }
  try {
    var gms = (Campaign().get("_gms") || "").split(",").filter(Boolean);
    return gms.indexOf(playerId) !== -1;
  } catch (e) { return false; }
}

// Idempotency cache for mutating writes. On a relay timeout the TS side cannot
// safely resend a write (it would double-apply), but a *same-nonce* resend that
// reaches the sandbox after the original processed must be a no-op that simply
// re-emits the original result. We remember the last N processed nonces and the
// result we wrote for each, and replay it instead of re-running the action.
var PROCESSED_NONCES = {};
var PROCESSED_ORDER = [];
var PROCESSED_MAX = 64;
function recordNonceResult(nonce, data, error) {
  if (nonce == null) return;
  var key = String(nonce);
  if (!(key in PROCESSED_NONCES)) PROCESSED_ORDER.push(key);
  PROCESSED_NONCES[key] = { data: data, error: error };
  while (PROCESSED_ORDER.length > PROCESSED_MAX) {
    delete PROCESSED_NONCES[PROCESSED_ORDER.shift()];
  }
}

// --- Globals ---
// CHAT_BUFFER stays in-memory (transient): it self-repopulates from live chat, and persisting a
// high-frequency 100-entry rolling buffer to `state` would churn the campaign save on every message.
const CHAT_BUFFER = [];
const CHAT_BUFFER_MAX = 100;
const DM_INBOX_MAX = 50;

// --- Payload-slimming helpers (keep relay reads lean — see docs/relay-payload-slimming.md) ---

// Project a graphic token to a field profile. imgsrc is in NONE — no caller reads it
// (art goes through createGraphic-type actions, never read-back).
function tokenSummary(t, profile) {
  var s = {
    id: t.id,
    name: t.get("name"),
    represents: t.get("represents") || "",
    controlledby: t.get("controlledby") || "",
    layer: t.get("layer"),
  };
  if (profile === "lean") return s;
  s.bar1_value = t.get("bar1_value");           // HP
  s.bar1_max = t.get("bar1_max");
  s.statusmarkers = t.get("statusmarkers");     // conditions
  if (profile === "status") return s;
  s.left = t.get("left");                        // geometry
  s.top = t.get("top");
  s.width = t.get("width");
  s.height = t.get("height");
  return s; // "full"
}

// Strip rolltemplate HTML / URLs down to text. The dice signal is preserved separately in
// inlinerolls, so this can be aggressive without ever losing a roll total.
function cleanChat(raw) {
  return String(raw == null ? "" : raw)
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/(div|p|tr|td|li|h[1-6])>/gi, " ")
    .replace(/<[^>]+>/g, "")                      // drop all tags (kills <img>, styled spans)
    .replace(/https?:\/\/\S+/g, "")               // drop bare URLs (avatars / marketplace art)
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'").replace(/&rsquo;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);                               // cleaned text is dense; 240 >> 600 raw
}

// Cheap bounding box from a points array — handles v1 [x,y] and pathv2 [cmd,x,y] points.
function bboxOf(points) {
  if (!Array.isArray(points) || !points.length) return null;
  var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  points.forEach(function (p) {
    if (!Array.isArray(p)) return;
    var x = p.length >= 3 ? p[1] : p[0];
    var y = p.length >= 3 ? p[2] : p[1];
    if (typeof x !== "number" || typeof y !== "number") return;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  });
  if (minX === Infinity) return null;
  return { minX: minX, minY: minY, maxX: maxX, maxY: maxY };
}

// Durable session state lives in Roll20's persistent `state` object so it survives a Mod sandbox
// restart / script redeploy. Previously these were module-level vars that were silently wiped on
// every save — which disarmed the turn hook mid-combat. B() is self-healing: it backfills any
// missing key, so it works on first run, after a redeploy, and when upgrading from an older shape.
function B() {
  let s = state.GM_AI_Bridge;
  if (!s) { s = state.GM_AI_Bridge = {}; }
  if (typeof s.round !== "number") s.round = 0;
  if (typeof s.turnHookEnabled !== "boolean") s.turnHookEnabled = false;
  if (!Array.isArray(s.dmInbox)) s.dmInbox = [];
  if (!s.mobPlans || typeof s.mobPlans !== "object") s.mobPlans = {};
  // PC hit points live here, NOT on the token bar: the player's Beyond20 plugin owns a
  // PC token's bar1 and overwrites anything we write. Keyed by lowercased token name →
  // { current, max, name, updated }. NPC HP stays on the token bar as before.
  if (!s.pcHp || typeof s.pcHp !== "object") s.pcHp = {};
  return s;
}

// True when a token is a player character (a real player controls it) — as opposed to
// an NPC/mob (no controller) or a shared summon (controlledby "all", no DDB sheet).
function isPcToken(t) {
  let cb = String(t.get("controlledby") || "").trim();
  return cb !== "" && cb.toLowerCase() !== "all";
}

function pcHpKey(name) { return String(name || "").split("\n")[0].trim().toLowerCase(); }

// PC HP carrier: a %%PCHP={...}%% block in the token's GM-only gmnotes (never shown to players).
// This is the SINGLE source of truth, shared raw with the RT client so it can read/write PC HP
// directly (off chat) while this Mod still sees it for turn-hook narration. (Replaces the old
// B().pcHp store; verified to round-trip raw in both directions over the realtime DB.)
var PCHP_RE = /%%PCHP=({[\s\S]*?})%%/;
function parsePcHpBlock(gm) {
  var m = String(gm == null ? "" : gm).match(PCHP_RE);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch (e) { return null; }
}
function writePcHpBlock(gm, entry) {
  var base = String(gm == null ? "" : gm).replace(PCHP_RE, "").replace(/\s+$/, "");
  return (base ? base + " " : "") + "%%PCHP=" + JSON.stringify(entry) + "%%";
}

// Adjust a PC's tracked HP in the token's gmnotes block (never touches the player-visible bar).
// Seeds current/max from the token bar the first time we touch a PC, then keeps the running value.
function adjustPcHp(t, args) {
  let name = (t.get("name") || "").split("\n")[0].trim();
  let gm = t.get("gmnotes") || "";
  let entry = parsePcHpBlock(gm);
  let tokBar = Number(t.get("bar1_value"));
  let tokMax = Number(t.get("bar1_max"));
  let cur = (entry && isFinite(entry.current)) ? entry.current : (isFinite(tokBar) ? tokBar : 0);
  let max = (entry && isFinite(entry.max) && entry.max > 0) ? entry.max : (isFinite(tokMax) ? tokMax : 0);
  let nv;
  if (args.setHp !== undefined && args.setHp !== null) nv = Number(args.setHp);
  else if (args.damage !== undefined && args.damage !== null) nv = Math.max(0, cur - Number(args.damage));
  else if (args.heal !== undefined && args.heal !== null) nv = max ? Math.min(max, cur + Number(args.heal)) : cur + Number(args.heal);
  else throw new Error("adjustPcHp: provide damage, heal, or setHp");
  if (!isFinite(nv)) throw new Error("adjustPcHp: computed HP is not finite (got " + JSON.stringify(nv) + ")");
  t.set("gmnotes", writePcHpBlock(gm, { current: nv, max: max, name: name, updated: Date.now() }));
  return { ok: true, pc: true, name: name, current: nv, max: max, tokenBar: isFinite(tokBar) ? tokBar : null };
}

// Display HP for a token: PCs read tracked state (token bar is Beyond20-owned and lies);
// NPCs read the bar. Returns { hp, maxHp, note } — note is set only when a PC's token bar
// disagrees with our tracked value (surfaced subtly in announcements).
function effectiveHp(t) {
  let hp = t.get("bar1_value");
  let maxHp = t.get("bar1_max");
  let note = null;
  if (isPcToken(t)) {
    let entry = parsePcHpBlock(t.get("gmnotes"));
    if (entry && isFinite(entry.current)) {
      let tokBar = Number(hp);
      if (isFinite(tokBar) && tokBar !== entry.current) note = { tracked: entry.current, max: entry.max, tokenBar: tokBar };
      hp = entry.current;
      if (entry.max) maxHp = entry.max;
    }
  }
  return { hp: hp, maxHp: maxHp, note: note };
}

// Save a token's portable configuration as its character's DEFAULT token (the token Roll20
// uses when the sheet is dragged onto a map). Copies art/bars/control/auras/light but strips
// page-instance fields (id, _pageid, left, top) so the default isn't pinned to a spot. Roll20
// stores this as a JSON string on the character's `defaulttoken` property.
function setDefaultTokenForChar(t, args) {
  var charId = args.charId || t.get("represents");
  if (!charId) throw new Error("Token has no linked character (represents) — pass charId or link the token first");
  var ch = getObj("character", charId);
  if (!ch) throw new Error("Character not found: " + charId);
  if (!t.get("represents")) t.set("represents", charId); // keep the link bidirectional
  var KEYS = [
    "name", "imgsrc", "represents", "controlledby",
    "bar1_link", "bar2_link", "bar3_link",
    "bar1_value", "bar1_max", "bar2_value", "bar2_max", "bar3_value", "bar3_max",
    "width", "height", "rotation", "statusmarkers", "tint_color",
    "aura1_radius", "aura1_color", "aura1_square", "showplayers_aura1",
    "aura2_radius", "aura2_color", "aura2_square", "showplayers_aura2",
    "showname", "showplayers_name", "showplayers_bar1", "showplayers_bar2", "showplayers_bar3",
    "light_radius", "light_dimradius", "light_otherplayers", "light_hassight",
    "light_angle", "light_losangle", "sides", "currentside",
  ];
  var props = {};
  KEYS.forEach(function (k) {
    var v = t.get(k);
    if (v !== undefined && v !== null && v !== "") props[k] = v;
  });
  ch.set("defaulttoken", JSON.stringify(props));
  return { ok: true, charId: charId, character: ch.get("name"), fields: Object.keys(props).length };
}

// --- Helpers ---

// Epithet word banks for disambiguating duplicate-named tokens at initiative roll time.
// Matched by substring against the token name (case-insensitive).
const MONSTER_EPITHETS = {
  goblin:    ["Sniveling","Savage","One-Eyed","Stinking","Cowardly","Bold","Gap-Toothed"],
  hobgoblin: ["Scarred","Disciplined","Ruthless","Iron-Fisted","Veteran","Grim"],
  bugbear:   ["Hulking","Sneaking","Slavering","Brutal","Heavy-Handed"],
  orc:       ["Berserk","Scarred","Bloodied","Raging","Brutal","Wailing"],
  gnoll:     ["Cackling","Slavering","Mangy","Frenzied","Bone-Crunching"],
  kobold:    ["Scurrying","Trap-Setting","Yapping","Scaled","Venomous"],
  zombie:    ["Shambling","Rotting","Bloated","Wailing","Ancient","Lurching"],
  ghoul:     ["Ravenous","Clawing","Foul","Swift","Gibbering"],
  ghast:     ["Reeking","Ancient","Savage","Wretched"],
  skeleton:  ["Brittle","Cursed","Clacking","Headless","Armored","Ancient"],
  specter:   ["Wailing","Pale","Shrieking","Vengeful","Keening"],
  wraith:    ["Ancient","Hungry","Silent","Seething","Cold"],
  vampire:   ["Pale","Ancient","Wrathful","Charming","Bloodthirsty"],
  wolf:      ["Hungry","Scarred","Black","Limping","Snarling","Gaunt"],
  werewolf:  ["Howling","Feral","Maddened","Hulking","Slavering"],
  rat:       ["Diseased","Scuttling","Mangy","Bloated","Foul"],
  bat:       ["Screeching","Swooping","Blood-Mad","Pale"],
  spider:    ["Bloated","Venomous","Ancient","Lurking","Bristling"],
  cultist:   ["Zealous","Frenzied","Devoted","Screaming","Hollow-Eyed"],
  guard:     ["Nervous","Grizzled","Corrupt","Loyal","Sweating"],
  bandit:    ["Scarred","Desperate","Cunning","Ruthless","Limping"],
  troll:     ["Regenerating","Stinking","Ancient","Howling","Massive"],
  ogre:      ["Bellowing","Stupid","Hungry","Scarred","Club-Fisted"],
};
const GENERIC_EPITHETS = [
  "Wrathful","Skulking","Wretched","Ravenous","Frenzied","Ancient","Withered",
  "Relentless","Cunning","Desperate","Scarred","Hungry","Pale","Lurking","Maddened",
  "Bloodied","Howling","Silent","Swift","Hollow-Eyed","Twisted","Gaunt",
];

// Draw a circle as a 36-point polygon path. Returns Roll20 path string.
// Path points are relative to the bounding box top-left corner.
// The bounding box is width=height=2*radiusPx, so center of circle = (radiusPx, radiusPx).
function makeCirclePath(radiusPx) {
  let r = radiusPx;
  let pts = [];
  for (let i = 0; i <= 36; i++) {
    let angle = (i / 36) * 2 * Math.PI;
    let x = r + r * Math.cos(angle);
    let y = r + r * Math.sin(angle);
    pts.push([i === 0 ? "M" : "L", Math.round(x * 100) / 100, Math.round(y * 100) / 100]);
  }
  pts.push(["Z"]);
  return JSON.stringify(pts);
}

function getMonsterEpithets(tokenName) {
  let lower = tokenName.toLowerCase();
  let keys = Object.keys(MONSTER_EPITHETS);
  for (let i = 0; i < keys.length; i++) {
    if (lower.indexOf(keys[i]) !== -1) return MONSTER_EPITHETS[keys[i]];
  }
  return GENERIC_EPITHETS;
}

// TIER 1a — true 5e conditions. These are the ONLY markers swept by
// syncConditionsToToken (DDB condition mirroring / "clear all conditions"), so
// keep this list to real conditions that DDB knows about.
const CONDITION_MARKERS = {
  dead:          "Unconscious::4444317",
  unconscious:   "Unconscious::4444317",
  poisoned:      "Poisoned::4444329",
  blinded:       "Blinded::4444318",
  charmed:       "Charmed::4444320",
  deafened:      "Deafened::4444321",
  frightened:    "Feared::4444323",
  grappled:      "Grappled::4444314",
  incapacitated: "Incapacitated::4444325",
  invisible:     "Invisible::4444344",
  paralyzed:     "Paralyzed::4444327",
  petrified:     "Petrified::4444328",
  prone:         "Prone::4444315",
  restrained:    "Restrained::4444316",
  stunned:       "Stunned::4444331",
  exhaustion:    "Exhausted::4444322",
};

// TIER 1b — pseudo-conditions: well-known iconography for states that aren't formal
// 5e conditions but are commonly tracked. Fixed icons, but DM-managed — deliberately
// NOT in CONDITION_MARKERS so a DDB sync / "clear conditions" never strips them.
const PSEUDO_MARKERS = {
  bloodied:      "Wounded::4444333", // "bloodied" is not a real Roll20 marker; alias to Wounded
  wounded:       "Wounded::4444333",
  concentrating: "Concentrating::4444313",
  concentration: "Concentrating::4444313",
  blessed:       "Blessed::4444338",
  bless:         "Blessed::4444338",
  bane:          "Bane::4444349",
  baned:         "Bane::4444349",
  hasted:        "Hastened::4444343",
  hastened:      "Hastened::4444343",
  haste:         "Hastened::4444343",
  raging:        "Rage::4444347",
  rage:          "Rage::4444347",
  marked:        "Marked::4444350",
  hidden:        "Hidden::4444335",
  hiding:        "Hidden::4444335",
  dodging:       "Dodging::4444334",
  dodge:         "Dodging::4444334",
  enlarged:      "Enlarged::4444340",
  flying:        "Flying::4444342",
  fly:           "Flying::4444342",
  sleeping:      "Sleeping::4444330",
  asleep:        "Sleeping::4444330",
  burning:       "Burning::4444319",
  surprised:     "Suprised::4444332",
  disguised:     "Disguised::4444339",
  featherfall:   "Featherfall::4444341",
  mirrorimage:   "MirrorImage::4444346",
  magicweapon:   "MagicWeapon::4444345",
  buffed:        "Buffed::4444336",
  drowning:      "Drowning::4444352",
  afflicted:     "Afflicted::4444348",
  cursed:        "Afflicted::4444348",
  illusion:      "Illusion::4444311",
  disarmed:      "Disarmed::4444324",
  mute:          "Mute::4444326",
  silenced:      "Mute::4444326",
  dismembered:   "Dismembered::4444312",
};

// TIER 2 — ad-hoc pool: abstract built-in icons (kept distinct from the meaningful
// condition/pseudo icons so iconography stays legible) used for arbitrary DM-defined
// states. A state name not in tier 1 deterministically hashes to one of these, and the
// binding + which tokens hold it are tracked in B().customStates (persisted campaign state).
const AD_HOC_POOL = [
  "aura", "radioactive", "cobweb", "trophy", "grenade", "stopwatch", "snail",
  "spanner", "fishing-net", "padlock", "three-leaves", "fist", "tread", "back-pain",
  "bolt-shield", "white-tower", "frozen-orb", "rolling-bomb", "screaming", "sentry-gun",
  "all-for-one", "angel-outfit", "archery-target", "drink-me", "death-zone", "edge-crack",
  "fluffy-wing", "interdiction", "lightning-helix", "ninja-mask", "overdrive", "strong",
  "arrowed", "black-flag", "flying-flag", "chemical-bolt", "grab", "half-haze", "pummeled",
];

// Deterministic name -> ad-hoc icon (FNV-ish). Same name always yields the same icon,
// no storage needed; distinct names can collide on an icon (acceptable — list_custom_states
// shows the bindings so the DM can see any overlap).
function hashToPool(name) {
  let s = String(name || "").toLowerCase();
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 16777619) >>> 0; }
  return AD_HOC_POOL[h % AD_HOC_POOL.length];
}

// Classify a state name into a marker tag + tier.
//   condition -> tracked 5e condition (active_conditions attr, swept by sync)
//   pseudo    -> fixed well-known icon, DM-managed
//   custom    -> hashed ad-hoc icon, tracked in B().customStates
function resolveMarkerForState(name) {
  let lc = String(name || "").toLowerCase().trim();
  if (CONDITION_MARKERS[lc]) return { tag: CONDITION_MARKERS[lc], tier: "condition", key: lc };
  if (PSEUDO_MARKERS[lc])    return { tag: PSEUDO_MARKERS[lc],    tier: "pseudo",    key: lc };
  return { tag: hashToPool(lc), tier: "custom", key: lc };
}

// Track a tier-2 custom state in persisted campaign state: which tokens currently hold it.
function trackCustomState(key, tag, tokenId, active) {
  let cs = B().customStates = B().customStates || {};
  let entry = cs[key] || { tag: tag, tokens: [] };
  let set = {};
  (entry.tokens || []).forEach(function (id) { set[id] = true; });
  if (active) set[tokenId] = true; else delete set[tokenId];
  entry.tokens = Object.keys(set);
  entry.tag = tag;
  if (entry.tokens.length === 0) delete cs[key]; else cs[key] = entry;
}

function setConditionAttr(charId, conditionSet) {
  let condStr = Array.from(conditionSet).join(",");
  let existing = findObjs({ _type: "attribute", _characterid: charId, name: "active_conditions" });
  if (existing.length > 0) {
    existing[0].set("current", condStr);
  } else {
    createObj("attribute", { characterid: charId, name: "active_conditions", current: condStr });
  }
}

// Resolve the props object for setTokenProps. Callers SHOULD pass
// { tokenId, props: {...} }, but small/cloud models routinely flatten the
// fields up to the top level ({ tokenId, name: "X" }). Tolerate both, and
// NEVER silently no-op: an empty prop set means a malformed call and must
// throw, so the agent learns it changed nothing instead of reporting success.
function normProps(args) {
  if (args.props && typeof args.props === "object") return args.props;
  var out = {};
  Object.keys(args).forEach(function (k) {
    if (k !== "tokenId" && k !== "action" && k !== "id" && k !== "props") out[k] = args[k];
  });
  return out;
}

// Firebase rejects `undefined` (and chokes on NaN) for ANY property. Worse, the
// bad value isn't rejected synchronously — t.set() schedules a deferred _doSave,
// and the failure later crashes the whole API sandbox (no try/catch can catch it).
// So scrub every props object before handing it to t.set().
function stripUndef(props) {
  var clean = {};
  Object.keys(props).forEach(function (k) {
    var v = props[k];
    if (v === undefined || v === null) return;
    if (typeof v === "number" && isNaN(v)) return;
    clean[k] = v;
  });
  return clean;
}

// Synchronous operation executor used by batchExec.
// Only sync-safe actions here — no sendChat callbacks.
function runBatchOp(action, args) {
  switch (action) {
    case "setTokenBar": {
      let t = getObj("graphic", args.tokenId);
      if (!t) throw new Error("Token not found: " + args.tokenId);
      let v = Number(args.value);
      if (!isFinite(v)) throw new Error("setTokenBar: value must be a finite number, got " + JSON.stringify(args.value));
      let p = { bar1_value: v };
      if (args.max !== undefined && isFinite(Number(args.max))) p.bar1_max = Number(args.max);
      t.set(p);
      return { ok: true };
    }
    case "adjustPcHp": {
      let t = getObj("graphic", args.tokenId);
      if (!t) throw new Error("Token not found: " + args.tokenId);
      return adjustPcHp(t, args);
    }
    case "setDefaultToken": {
      let t = getObj("graphic", args.tokenId);
      if (!t) throw new Error("Token not found: " + args.tokenId);
      return setDefaultTokenForChar(t, args);
    }
    case "setTokenProps": {
      let t = getObj("graphic", args.tokenId);
      if (!t) throw new Error("Token not found: " + args.tokenId);
      let props = stripUndef(normProps(args));
      let keys = Object.keys(props);
      if (keys.length === 0) throw new Error("setTokenProps: no properties to set — pass props:{...} (or top-level fields)");
      t.set(props);
      return { ok: true, set: keys };
    }
    case "toggleCondition": {
      let t = getObj("graphic", args.tokenId);
      if (!t) throw new Error("Token not found: " + args.tokenId);
      let cond = (args.condition || "").toLowerCase();
      let res = resolveMarkerForState(cond);
      let marker = res.tag;
      let ms = new Set((t.get("statusmarkers") || "").split(",").filter(Boolean));
      if (args.active) ms.add(marker); else ms.delete(marker);
      t.set("statusmarkers", Array.from(ms).join(","));
      if (res.tier === "condition" && args.charId) {
        let existing = findObjs({ _type: "attribute", _characterid: args.charId, name: "active_conditions" });
        let condList = existing.length > 0 ? (existing[0].get("current") || "").split(",").filter(Boolean) : [];
        let cs = new Set(condList);
        if (args.active) cs.add(cond); else cs.delete(cond);
        setConditionAttr(args.charId, cs);
      }
      if (res.tier === "custom") trackCustomState(res.key, marker, args.tokenId, !!args.active);
      return { ok: true, marker: marker, tier: res.tier };
    }
    case "syncConditionsToToken": {
      let t = getObj("graphic", args.tokenId);
      if (!t) throw new Error("Token not found: " + args.tokenId);
      let activeSet = new Set((args.conditions || []).map(function(c) { return c.toLowerCase(); }));
      let markerSet = new Set((t.get("statusmarkers") || "").split(",").filter(Boolean));
      let allKnown = new Set();
      Object.keys(CONDITION_MARKERS).forEach(function(c) {
        let tag = CONDITION_MARKERS[c];
        allKnown.add(tag);
        let dn = tag.split("::")[0];
        allKnown.add(dn);
        allKnown.add(dn.toLowerCase());
      });
      allKnown.forEach(function(m) { markerSet.delete(m); });
      activeSet.forEach(function(c) {
        let m = CONDITION_MARKERS[c];
        if (m) markerSet.add(m);
      });
      t.set("statusmarkers", Array.from(markerSet).join(","));
      if (args.charId) setConditionAttr(args.charId, activeSet);
      return { ok: true, conditions: Array.from(activeSet) };
    }
    case "getTokenById": {
      // Single source of truth — the rich token shape. The main-switch case
      // delegates here so there is exactly one implementation.
      let t = getObj("graphic", args.tokenId);
      if (!t) return null;
      return {
        id: t.id,
        name: t.get("name"),
        represents: t.get("represents") || "",
        layer: t.get("layer"),
        controlledby: t.get("controlledby") || "",
        left: t.get("left"),
        top: t.get("top"),
        width: t.get("width"),
        height: t.get("height"),
        rotation: t.get("rotation"),
        imgsrc: t.get("imgsrc"),
        statusmarkers: t.get("statusmarkers") || "",
        bar1_value: t.get("bar1_value"),
        bar1_max: t.get("bar1_max"),
        bar2_value: t.get("bar2_value"),
        bar2_max: t.get("bar2_max"),
        bar3_value: t.get("bar3_value"),
        bar3_max: t.get("bar3_max"),
        aura1_radius: t.get("aura1_radius"),
        aura1_color: t.get("aura1_color"),
        aura1_square: t.get("aura1_square"),
        showplayers_aura1: t.get("showplayers_aura1"),
        aura2_radius: t.get("aura2_radius"),
        aura2_color: t.get("aura2_color"),
        aura2_square: t.get("aura2_square"),
        showplayers_aura2: t.get("showplayers_aura2"),
        tint_color: t.get("tint_color"),
        light_radius: t.get("light_radius"),
        light_dimradius: t.get("light_dimradius"),
        gmnotes: t.get("gmnotes") || "",
      };
    }
    case "setTurnOrder": {
      Campaign().set("turnorder", JSON.stringify(args.turnorder || []));
      return { ok: true };
    }
    case "createHandout": {
      let h = createObj("handout", {
        name: args.name || "Handout",
        inplayerjournals: args.inplayerjournals || "",
        controlledby: args.controlledby || "",
        archived: false,
      });
      if (!h) throw new Error("createObj('handout') returned undefined");
      if (args.notes !== undefined) h.set("notes", args.notes);
      if (args.gmnotes !== undefined) h.set("gmnotes", args.gmnotes);
      if (args.avatar) h.set("avatar", args.avatar);
      return { id: h.id };
    }
    case "createCharacter": {
      let ch = createObj("character", {
        name: args.name || "Creature",
        inplayerjournals: args.inplayerjournals || "",
        controlledby: args.controlledby || "",
        archived: false,
      });
      if (!ch) throw new Error("createObj('character') returned undefined");
      if (args.bio !== undefined) ch.set("bio", args.bio);
      if (args.gmnotes !== undefined) ch.set("gmnotes", args.gmnotes);
      if (args.avatar) ch.set("avatar", args.avatar);
      (args.attributes || []).forEach(function(a) {
        createObj("attribute", {
          characterid: ch.id,
          name: a.name,
          current: a.current != null ? a.current : "",
          max: a.max != null ? a.max : "",
        });
      });
      return { id: ch.id };
    }
    default:
      throw new Error("batchExec: unsupported action '" + action + "'. Supported: setTokenBar, adjustPcHp, setDefaultToken, setTokenProps, toggleCondition, syncConditionsToToken, getTokenById, setTurnOrder, createHandout, createCharacter");
  }
}

on("chat:message", function (msg) {
  // Buffer only real table chat: not relay commands, and NOT our own API/bridge output
  // (AIBRIDGE_RESULT whispers, Initiative announces, whisperPlayer — all playerid "API").
  // Beyond20 player rolls keep a real playerid, so they're retained.
  if (msg.content && typeof msg.content === "string"
      && !msg.content.startsWith("!ai-relay")
      && msg.playerid !== "API") {
    CHAT_BUFFER.push({
      who: msg.who || "",
      type: msg.type || "",
      content: cleanChat(msg.content),
      inlinerolls: (msg.inlinerolls || []).map(function(r) {
        return { expression: r.expression, total: r.results ? r.results.total : null };
      }),
      timestamp: Date.now(),
    });
    if (CHAT_BUFFER.length > CHAT_BUFFER_MAX) CHAT_BUFFER.shift();
  }

  // Player turn preloading / queries via !dm
  if (msg.type === "api" && msg.content && msg.content.startsWith("!dm ")) {
    let dmText = msg.content.slice(4).trim();
    if (dmText) {
      let isQuery = /^(what|who|how|is|am|are|do|does|can|did|\?)/i.test(dmText) || dmText.endsWith("?");
      let inbox = B().dmInbox;
      inbox.push({
        who: msg.who || "",
        playerid: msg.playerid || "",
        content: dmText,
        type: isQuery ? "query" : "intent",
        timestamp: Date.now(),
      });
      if (inbox.length > DM_INBOX_MAX) inbox.shift();
      sendChat("Initiative", "/desc 🎲 **" + (msg.who || "Someone") + "** has set their mind to an action.");
      let ackVerb = isQuery ? "Got your question — I'll answer shortly." : "Got it — I'll have this ready for your turn.";
      sendChat("GM-AI-Bridge", "/w " + (msg.who || "gm") + " " + ackVerb + " (" + dmText + ")", null, { noarchive: true });
    }
    return;
  }

  if (msg.type !== "api") return;

  if (!msg.content.startsWith("!ai-relay ")) return;

  // GM-only: the relay grants full campaign-mutation power, so only accept it
  // from a GM. Any other api-capable player is silently rejected.
  if (!senderIsGM(msg.playerid)) {
    log("[GM_AI_Bridge] rejected !ai-relay from non-GM playerid=" + (msg.playerid || "?"));
    return;
  }

  let cmd;
  try {
    cmd = JSON.parse(msg.content.slice("!ai-relay ".length));
  } catch (e) {
    return;
  }

  const { action, nonce, ...args } = cmd;
  const senderPlayerId = msg.playerid || "";

  log("[GM_AI_Bridge] action=" + action + " nonce=" + nonce);

  // Idempotent replay: if we've already processed this exact nonce, echo the
  // stored result instead of re-running the action (a re-send of a mutating
  // write must not double-apply).
  if (nonce != null && Object.prototype.hasOwnProperty.call(PROCESSED_NONCES, String(nonce))) {
    let prior = PROCESSED_NONCES[String(nonce)];
    writeResult(nonce, prior.data, prior.error);
    return;
  }

  try {
    switch (action) {
      case "getTokens": {
        // profile: "lean" | "status" | "full" (default). imgsrc dropped from all — no caller reads it.
        const profile = args.profile || "full";
        const tokens = findObjs({ _type: "graphic", _pageid: args.pageId });
        writeResult(nonce, tokens.map((t) => tokenSummary(t, profile)));
        break;
      }

      case "getSelection": {
        // Roll20 exposes the current selection ONLY as msg.selected on the chat command
        // that triggered this handler — there is no passive getSelectedTokens() in the
        // sandbox. The bridge sends !ai-relay while the GM has tokens selected, so this
        // reflects the live tabletop selection in the GM's session.
        // Each msg.selected entry is { _id, _type }. Resolve graphics to name + linked character.
        let sel = msg.selected || [];
        let selResults = sel.map(function (s) {
          if (s._type !== "graphic") return { id: s._id, type: s._type };
          let t = getObj("graphic", s._id);
          if (!t) return { id: s._id, error: "not found" };
          let charId = t.get("represents") || "";
          let charName = "";
          if (charId) {
            let ch = getObj("character", charId);
            if (ch) charName = ch.get("name");
          }
          let summ = tokenSummary(t, "full");
          summ.characterName = charName;
          return summ;
        });
        writeResult(nonce, selResults);
        break;
      }

      case "setTokenBar": {
        const token = getObj("graphic", args.tokenId);
        if (!token) throw new Error(`Token not found: ${args.tokenId}`);
        const v = Number(args.value);
        if (!isFinite(v)) throw new Error(`setTokenBar: value must be a finite number, got ${JSON.stringify(args.value)}`);
        token.set({
          bar1_value: v,
          ...(args.max !== undefined && isFinite(Number(args.max)) ? { bar1_max: Number(args.max) } : {}),
        });
        writeResult(nonce, { ok: true });
        break;
      }

      case "adjustPcHp": {
        const token = getObj("graphic", args.tokenId);
        if (!token) throw new Error(`Token not found: ${args.tokenId}`);
        writeResult(nonce, adjustPcHp(token, args));
        break;
      }

      case "getPcHp": {
        // Read tracked PC HP from the token gmnotes PCHP block (single source of truth).
        // tokenId → that token; characterName → first matching PC token; otherwise the whole map.
        if (args.tokenId) {
          let t = getObj("graphic", args.tokenId);
          writeResult(nonce, t ? parsePcHpBlock(t.get("gmnotes")) : null);
        } else if (args.characterName) {
          let want = pcHpKey(args.characterName);
          let found = null;
          findObjs({ _type: "graphic" }).forEach(function(t) {
            if (found) return;
            if (pcHpKey(t.get("name")) === want) { let e = parsePcHpBlock(t.get("gmnotes")); if (e) found = e; }
          });
          writeResult(nonce, found);
        } else {
          let map = {};
          findObjs({ _type: "graphic" }).forEach(function(t) {
            let e = parsePcHpBlock(t.get("gmnotes"));
            if (e) map[pcHpKey(t.get("name"))] = e;
          });
          writeResult(nonce, map);
        }
        break;
      }

      case "setDefaultToken": {
        const token = getObj("graphic", args.tokenId);
        if (!token) throw new Error(`Token not found: ${args.tokenId}`);
        writeResult(nonce, setDefaultTokenForChar(token, args));
        break;
      }

      case "setStatusMarker": {
        const token = getObj("graphic", args.tokenId);
        if (!token) throw new Error(`Token not found: ${args.tokenId}`);
        const current = token.get("statusmarkers") || "";
        const markers = current ? current.split(",") : [];
        if (args.active && !markers.includes(args.marker)) {
          markers.push(args.marker);
        } else if (!args.active) {
          const idx = markers.indexOf(args.marker);
          if (idx !== -1) markers.splice(idx, 1);
        }
        token.set("statusmarkers", markers.join(","));
        writeResult(nonce, { ok: true });
        break;
      }

      case "createToken": {
        const token = createObj("graphic", {
          _pageid: args.pageId,
          imgsrc: args.imgsrc,
          name: args.name,
          layer: args.layer || "tokens",
          left: args.left || 70,
          top: args.top || 70,
          width: args.width || 70,
          height: args.height || 70,
          bar1_value: args.bar1_value || 0,
          bar1_max: args.bar1_max || 0,
          showname: true,
          showplayers_name: true,
          showplayers_bar1: true,
        });
        // createObj('graphic') returns undefined when imgsrc is missing or not a
        // Roll20-hosted URL (external/marketplace/thumb URLs are silently refused).
        // Guard so callers get an actionable message, not "Cannot read 'id' of undefined".
        if (!token) throw new Error("createObj('graphic') returned undefined — imgsrc must be an uploaded Roll20 URL (https://s3.amazonaws.com/files.d20.io/.../max/... or /med/...), not an external/thumb URL");
        writeResult(nonce, { id: token.id });
        break;
      }

      case "createPage": {
        // Roll20 API does not support createObj("page") — pages must be created manually in the UI.
        throw new Error("Roll20 API does not allow creating pages programmatically. Create the page manually in the Roll20 page navigator, then pass its pageId.");
      }

      case "createPath": {
        const pathObj = createObj("path", {
          pageid: args.pageId,
          layer: args.layer || "walls",
          path: args.path,
          stroke: args.stroke || "#000000",
          stroke_width: args.stroke_width || 5,
          fill: args.fill || "transparent",
          left: args.left,
          top: args.top,
          width: args.width,
          height: args.height,
          rotation: args.rotation || 0,
          scaleX: 1,
          scaleY: 1,
          controlledby: "",
        });
        if (!pathObj) throw new Error("createObj('path') returned undefined — check pageid and path format");
        writeResult(nonce, { id: pathObj.id });
        break;
      }

      case "createPaths": {
        // Batch create — avoids one relay round-trip per path.
        const results = (args.paths || []).map((p) => {
          const pathObj = createObj("path", {
            pageid: args.pageId,
            layer: p.layer || args.layer || "walls",
            path: p.path,
            stroke: p.stroke || args.stroke || "#000000",
            stroke_width: p.stroke_width || args.stroke_width || 5,
            fill: p.fill || args.fill || "transparent",
            left: p.left,
            top: p.top,
            width: p.width,
            height: p.height,
            rotation: p.rotation || 0,
            scaleX: 1,
            scaleY: 1,
            controlledby: "",
          });
          return pathObj ? { id: pathObj.id } : { error: "createObj returned undefined" };
        });
        writeResult(nonce, results);
        break;
      }

      case "getWalls": {
        // Read pathv2 DL barrier objects (Latest VTT Engine / UDL) from a page.
        // Default to a metadata summary (count + bbox); raw point arrays are huge — pass
        // includePoints:true only when geometry is actually needed (placement verification).
        let includePoints = args.includePoints === true;
        let walls = findObjs({ _type: "pathv2", _pageid: args.pageId, layer: "walls" });
        writeResult(nonce, walls.map(function(w) {
          let pts = w.get("points");
          let base = {
            id: w.id,
            x: w.get("x"),
            y: w.get("y"),
            barrierType: w.get("barrierType"),
            shape: w.get("shape"),
            pointCount: Array.isArray(pts) ? pts.length : 0,
            bbox: bboxOf(pts),
          };
          if (includePoints) base.points = pts;
          return base;
        }));
        break;
      }

      case "debugPage": {
        // Enumerate what types of objects exist on a page — helps diagnose object storage.
        let types = ["path", "pathv2", "graphic", "wall", "text", "door", "window"];
        let summary = {};
        types.forEach(function(t) {
          let objs = findObjs({ _type: t, _pageid: args.pageId });
          summary[t] = { count: objs.length };
          if (objs.length && objs.length <= 5) {
            summary[t].sample = objs.slice(0, 3).map(function(o) {
              return { id: o.id, layer: o.get("layer"), barrierType: o.get("barrierType"), shape: o.get("shape") };
            });
          }
        });
        writeResult(nonce, summary);
        break;
      }

      case "createWalls": {
        // Create path objects on the walls layer with a custom stroke color.
        // path objects respect stroke color in the DL editor; pathv2 does not.
        // Each wall: { x1, y1, x2, y2, stroke? } in page pixel coordinates.
        let wallResults = (args.walls || []).map(function(w) {
          let minX = Math.min(w.x1, w.x2);
          let minY = Math.min(w.y1, w.y2);
          let wallObj = createObj("path", {
            pageid: args.pageId,
            layer: "walls",
            path: JSON.stringify([["M", w.x1 - minX, w.y1 - minY], ["L", w.x2 - minX, w.y2 - minY]]),
            left: (w.x1 + w.x2) / 2,
            top:  (w.y1 + w.y2) / 2,
            width:  Math.abs(w.x2 - w.x1),
            height: Math.abs(w.y2 - w.y1),
            stroke: w.stroke || args.stroke || "#FFFF00",
            stroke_width: 5,
            fill: "transparent",
            rotation: 0,
            scaleX: 1,
            scaleY: 1,
            controlledby: "",
          });
          return wallObj ? { id: wallObj.id } : { error: "createObj('path') returned undefined" };
        });
        writeResult(nonce, wallResults);
        break;
      }

      case "createDLDoors": {
        // Create native Roll20 DL door objects. Coordinates in page pixels; y is negated for Roll20.
        // Each door: { x, y, x0, y0, x1, y1, color? } — x/y center, x0/y0 and x1/y1 endpoints (pre-negated).
        let doorResults = (args.doors || []).map(function(d) {
          let obj = createObj("door", {
            pageid: args.pageId,
            x: d.x,
            y: d.y,
            path: { handle0: { x: d.x0, y: d.y0 }, handle1: { x: d.x1, y: d.y1 } },
            color: d.color || "#FF0000",
            isOpen: false,
            isLocked: false,
          });
          return obj ? { id: obj.id } : { error: "createObj('door') returned undefined" };
        });
        writeResult(nonce, doorResults);
        break;
      }

      case "createDLWindows": {
        // Create native Roll20 DL window objects. Same coordinate convention as createDLDoors.
        let windowResults = (args.windows || []).map(function(w) {
          let obj = createObj("window", {
            pageid: args.pageId,
            x: w.x,
            y: w.y,
            path: { handle0: { x: w.x0, y: w.y0 }, handle1: { x: w.x1, y: w.y1 } },
            color: w.color || "#00FFFF",
            isOpen: false,
            isLocked: false,
          });
          return obj ? { id: obj.id } : { error: "createObj('window') returned undefined" };
        });
        writeResult(nonce, windowResults);
        break;
      }

      case "createGraphic": {
        const graphic = createObj("graphic", {
          pageid: args.pageId,
          layer: args.layer || "map",
          imgsrc: args.imgsrc,
          name: args.name || "",
          left: args.left,
          top: args.top,
          width: args.width,
          height: args.height,
          rotation: args.rotation || 0,
          controlledby: "",
          showname: false,
        });
        if (!graphic) throw new Error("createObj('graphic') returned undefined");
        writeResult(nonce, { id: graphic.id });
        break;
      }

      case "setPageBackground": {
        const page = getObj("page", args.pageId);
        if (!page) throw new Error(`Page not found: ${args.pageId}`);
        page.set({ background_color: args.color || "#ffffff" });
        writeResult(nonce, { ok: true });
        break;
      }

      case "listPages": {
        const pages = findObjs({ _type: "page" });
        writeResult(nonce, pages.map((p) => ({
          id: p.id,
          name: p.get("name"),
          width: p.get("width"),
          height: p.get("height"),
        })));
        break;
      }

      case "setPageProps": {
        const page = getObj("page", args.pageId);
        if (!page) throw new Error(`Page not found: ${args.pageId}`);
        const props = {};
        if (args.name !== undefined) props.name = args.name;
        if (args.width !== undefined) props.width = args.width;
        if (args.height !== undefined) props.height = args.height;
        if (args.scale_number !== undefined) props.scale_number = args.scale_number;
        if (args.scale_units !== undefined) props.scale_units = args.scale_units;
        if (args.showgrid !== undefined) props.showgrid = args.showgrid;
        if (args.background_color !== undefined) props.background_color = args.background_color;
        page.set(props);
        writeResult(nonce, { ok: true, width: page.get("width"), height: page.get("height") });
        break;
      }

      case "getPaths": {
        // Read back all path/graphic objects from a page. If layer is omitted, returns all layers.
        let query = { _pageid: args.pageId };
        if (args.layer) query.layer = args.layer;
        // left/top/width/height already give the bounding box; the raw SVG `path` string and
        // graphic imgsrc are the bloat — gate both behind includePath (default off).
        let includePath = args.includePath === true;
        let paths = findObjs(Object.assign({ _type: "path" }, query));
        let graphics = args.includeGraphics ? findObjs(Object.assign({ _type: "graphic" }, query)) : [];
        let results = paths.map(function(p) {
          let base = {
            type: "path",
            id: p.id,
            layer: p.get("layer"),
            left: p.get("left"),
            top: p.get("top"),
            width: p.get("width"),
            height: p.get("height"),
            rotation: p.get("rotation"),
            stroke: p.get("stroke"),
          };
          if (includePath) base.path = p.get("path");
          return base;
        }).concat(graphics.map(function(g) {
          let base = {
            type: "graphic",
            id: g.id,
            layer: g.get("layer"),
            left: g.get("left"),
            top: g.get("top"),
            width: g.get("width"),
            height: g.get("height"),
            rotation: g.get("rotation"),
          };
          if (includePath) base.imgsrc = g.get("imgsrc");
          return base;
        }));
        writeResult(nonce, results);
        break;
      }

      case "getDoors": {
        // door/window objects use pageid (not _pageid) and inverted y-axis.
        // y values from Roll20 are negative; negate them to get normal page coords.
        function mapOpening(obj, type) {
          let path = obj.get("path") || {};
          let h0 = path.handle0 || {};
          let h1 = path.handle1 || {};
          return {
            id: obj.id,
            type: type,
            x: obj.get("x"),
            y: -(obj.get("y")),
            handle0: { x: h0.x, y: h0.y !== undefined ? -(h0.y) : undefined },
            handle1: { x: h1.x, y: h1.y !== undefined ? -(h1.y) : undefined },
            color: obj.get("color"),
            isOpen: obj.get("isOpen"),
            isLocked: obj.get("isLocked"),
            isSecret: obj.get("isSecret"),
          };
        }
        let doors = findObjs({ _type: "door", pageid: args.pageId });
        let windows = findObjs({ _type: "window", pageid: args.pageId });
        writeResult(nonce, {
          doors: doors.map(function(d) { return mapOpening(d, "door"); }),
          windows: windows.map(function(w) { return mapOpening(w, "window"); }),
        });
        break;
      }

      case "clearLayer": {
        // Remove all path/graphic objects from the specified layer on a page.
        // Also clears UDL wall objects when the "walls" layer is targeted.
        const page = getObj("page", args.pageId);
        if (!page) throw new Error(`Page not found: ${args.pageId}`);
        const layers = args.layers || [args.layer || "walls"];
        let removed = 0;
        layers.forEach(function(layer) {
          findObjs({ _type: "path", _pageid: args.pageId, layer: layer }).forEach(function(obj) {
            obj.remove();
            removed++;
          });
          findObjs({ _type: "graphic", _pageid: args.pageId, layer: layer }).forEach(function(obj) {
            obj.remove();
            removed++;
          });
          if (layer === "walls") {
            // Remove pathv2 DL barriers (Latest VTT Engine) and legacy wall objects.
            findObjs({ _type: "pathv2", _pageid: args.pageId, layer: "walls" }).forEach(function(obj) {
              obj.remove();
              removed++;
            });
            findObjs({ _type: "wall", _pageid: args.pageId }).forEach(function(obj) {
              obj.remove();
              removed++;
            });
            findObjs({ _type: "wall", pageid: args.pageId }).forEach(function(obj) {
              obj.remove();
              removed++;
            });
          }
        });
        writeResult(nonce, { removed: removed });
        break;
      }

      case "drawLayerTest": {
        // Draw one diagonal line per layer using legacy path objects to identify which layers Roll20's UI shows.
        // Coordinates use top-left-relative convention (UVTT importer style):
        // path points are relative to bounding box min corner, always positive.
        // left/top = center of bounding box = minX+width/2, minY+height/2.
        let layerTests = [
          { layer: "map",        stroke: "#FF0000", path: '[["M",0,0],["L",2170,2940]]',    left: 1085, top: 1470, width: 2170, height: 2940 },
          { layer: "objects",    stroke: "#00FF00", path: '[["M",2170,0],["L",0,2940]]',    left: 1085, top: 1470, width: 2170, height: 2940 },
          { layer: "foreground", stroke: "#FF00FF", path: '[["M",0,0],["L",2170,0]]',       left: 1085, top:  980, width: 2170, height: 0 },
          { layer: "gmlayer",    stroke: "#0000FF", path: '[["M",0,0],["L",2170,0]]',       left: 1085, top: 1470, width: 2170, height: 0 },
          { layer: "walls",      stroke: "#FF8800", path: '[["M",0,0],["L",0,2940]]',       left: 1085, top: 1470, width: 0,    height: 2940 },
        ];
        let results = layerTests.map(function(t) {
          let obj = createObj("path", {
            pageid: args.pageId,
            layer: t.layer,
            path: t.path,
            stroke: t.stroke,
            stroke_width: 10,
            fill: "transparent",
            left: t.left,
            top: t.top,
            width: t.width,
            height: t.height,
            rotation: 0,
            scaleX: 1,
            scaleY: 1,
            controlledby: senderPlayerId,
          });
          return { layer: t.layer, stroke: t.stroke, id: obj ? obj.id : null };
        });
        writeResult(nonce, results);
        break;
      }

      case "runUVTT": {
        // Create a carrier graphic on gmlayer with UVTT JSON in its gmnotes,
        // then trigger the UniversalVTTImporter mod via !uvtt --ids.
        let uvttGraphic = createObj("graphic", {
          _pageid: args.pageId,
          layer: "gmlayer",
          name: "uvtt-data-carrier",
          left: 35,
          top: 35,
          width: 70,
          height: 70,
          controlledby: "",
          showname: false,
        });
        if (!uvttGraphic) throw new Error("Failed to create carrier graphic for UVTT import");

        let uvttJson = typeof args.uvttData === "string"
          ? args.uvttData
          : JSON.stringify(args.uvttData);
        uvttGraphic.set("gmnotes", uvttJson);

        let extraArgs = args.noObjects ? " --no-objects" : "";
        let uvttCmd = "!uvtt --ids " + uvttGraphic.id + extraArgs;
        sendChat("API", uvttCmd);

        writeResult(nonce, {
          graphicId: uvttGraphic.id,
          command: uvttCmd,
          note: "UVTT import triggered. Delete graphicId when done.",
        });
        break;
      }

      case "createPolylines": {
        // Create one path object per polyline from an ordered list of absolute-pixel points.
        // Each polyline: { points: [[x,y], ...], stroke?, stroke_width?, closed?, layer? }
        let polylineResults = (args.polylines || []).map(function(pl) {
          let pts = pl.points || [];
          if (pts.length < 2) return { error: "Need at least 2 points" };
          let minX = Math.min.apply(null, pts.map(function(p) { return p[0]; }));
          let minY = Math.min.apply(null, pts.map(function(p) { return p[1]; }));
          let maxX = Math.max.apply(null, pts.map(function(p) { return p[0]; }));
          let maxY = Math.max.apply(null, pts.map(function(p) { return p[1]; }));
          let pathCmds = pts.map(function(p, i) {
            return [i === 0 ? "M" : "L", p[0] - minX, p[1] - minY];
          });
          if (pl.closed) pathCmds.push(["Z"]);
          let pathObj = createObj("path", {
            pageid: args.pageId,
            layer: pl.layer || args.layer || "walls",
            path: JSON.stringify(pathCmds),
            left: (minX + maxX) / 2,
            top: (minY + maxY) / 2,
            width: Math.max(maxX - minX, 1),
            height: Math.max(maxY - minY, 1),
            stroke: pl.stroke || args.stroke || "#FFFF00",
            stroke_width: pl.stroke_width || args.stroke_width || 5,
            fill: pl.fill || args.fill || "transparent",
            rotation: 0,
            scaleX: 1,
            scaleY: 1,
            controlledby: "",
          });
          return pathObj ? { id: pathObj.id, pointCount: pts.length } : { error: "createObj('path') returned undefined" };
        });
        writeResult(nonce, polylineResults);
        break;
      }

      case "clearDLOpenings": {
        // Remove all native door and window DL objects from a page.
        let removed = 0;
        findObjs({ _type: "door", pageid: args.pageId }).forEach(function(o) { o.remove(); removed++; });
        findObjs({ _type: "window", pageid: args.pageId }).forEach(function(o) { o.remove(); removed++; });
        writeResult(nonce, { removed: removed });
        break;
      }

      case "getTurnOrder": {
        let rawOrder = Campaign().get("turnorder");
        let parsed = rawOrder ? JSON.parse(rawOrder) : [];
        // Drop the per-entry _pageid (repeated on every row, never read downstream); keep
        // everything else (id, pr, custom, formula for round markers).
        writeResult(nonce, parsed.map(function(e) {
          let o = {};
          for (let k in e) { if (k !== "_pageid") o[k] = e[k]; }
          return o;
        }));
        break;
      }

      case "setTurnOrder": {
        Campaign().set("turnorder", JSON.stringify(args.entries || []));
        writeResult(nonce, { ok: true, count: (args.entries || []).length });
        break;
      }

      case "mergeTurnOrder": {
        // Atomic upsert into the live turn order — read, merge, write in ONE
        // sandbox tick so it never clobbers entries (e.g. player initiatives)
        // added between a read and a write. Each entry is matched by `id`:
        // replace in place if that id already exists, else append. Custom rows
        // (id "-1") have no stable identity, so they are always inserted, never
        // matched. After merging we sort pr-descending (Roll20's convention),
        // keeping custom "-1" rows in their inserted relative order.
        //
        // clearNpcFirst: true → strip all non-PC token entries before merging.
        // Keeps player-controlled tokens (controlledby = a real player ID) and
        // custom rows (id "-1", e.g. round markers). Safe replacement for a full
        // setTurnOrder([]) wipe that would also erase player entries.
        let rawTO = Campaign().get("turnorder");
        let merged;
        try { merged = rawTO ? JSON.parse(rawTO) : []; } catch (e) { merged = []; }
        if (!Array.isArray(merged)) merged = [];
        if (args.clearNpcFirst) {
          merged = merged.filter(function(entry) {
            if (!entry) return false;
            if (String(entry.id) === "-1") return true; // keep round markers / custom rows
            let t = getObj("graphic", entry.id);
            if (!t) return false; // stale entry → remove
            let cb = String(t.get("controlledby") || "").trim();
            return cb !== "" && cb.toLowerCase() !== "all"; // keep player-controlled only
          });
        }
        let incoming = args.entries || [];
        incoming.forEach(function (entry) {
          if (!entry || typeof entry !== "object") return;
          let id = entry.id;
          if (id != null && String(id) !== "-1") {
            let idx = -1;
            for (let i = 0; i < merged.length; i++) {
              if (merged[i] && String(merged[i].id) === String(id)) { idx = i; break; }
            }
            if (idx !== -1) { merged[idx] = entry; return; }
          }
          merged.push(entry);
        });
        // Stable pr-descending sort. Math, not lexical, so "10" sorts above "9".
        merged = merged
          .map(function (e, i) { return { e: e, i: i }; })
          .sort(function (a, b) {
            let pa = Number(a.e && a.e.pr);
            let pb = Number(b.e && b.e.pr);
            if (isNaN(pa)) pa = -Infinity;
            if (isNaN(pb)) pb = -Infinity;
            if (pb !== pa) return pb - pa;
            return a.i - b.i; // preserve original order on ties
          })
          .map(function (x) { return x.e; });
        Campaign().set("turnorder", JSON.stringify(merged));
        writeResult(nonce, { ok: true, turnorder: merged });
        break;
      }

      case "rollInitiativeForTokens": {
        // Roll d20 + initiative bonus for each token. Tries common 5e attribute names.
        // Posts a public gothic HTML initiative card by default (rollPublic defaults true).
        // Duplicate-named tokens are renamed with a random epithet (e.g. "Goblin the Savage") so they
        // are distinguishable both on the map and in the turn tracker.
        let initAttrNames = ["initiative_bonus", "npc_initiative", "dex_mod", "dexterity_mod"];
        let rollPublic = args.rollPublic !== false; // default true

        // Pass 1: count names to detect duplicates
        let nameCounts = {};
        (args.tokenIds || []).forEach(function(tokenId) {
          let token = getObj("graphic", tokenId);
          if (!token) return;
          let n = token.get("name");
          nameCounts[n] = (nameCounts[n] || 0) + 1;
        });

        // Pass 2: rename duplicates with epithets drawn from monster-type word banks
        let usedEpithets = {};
        (args.tokenIds || []).forEach(function(tokenId) {
          let token = getObj("graphic", tokenId);
          if (!token) return;
          let baseName = token.get("name");
          if ((nameCounts[baseName] || 0) <= 1) return;
          if (!usedEpithets[baseName]) usedEpithets[baseName] = [];
          let pool = getMonsterEpithets(baseName);
          let available = pool.filter(function(e) { return usedEpithets[baseName].indexOf(e) === -1; });
          if (!available.length) available = pool;
          let chosen = available[Math.floor(Math.random() * available.length)];
          usedEpithets[baseName].push(chosen);
          token.set({ name: baseName + " the " + chosen, tooltip: baseName + " the " + chosen, showname: true, showplayers_name: true });
        });

        // Pass 3: gather init bonuses (synchronous), then roll via Roll20's real dice engine
        let rollNonce = nonce;
        let tokenData = [];
        (args.tokenIds || []).forEach(function(tokenId) {
          let token = getObj("graphic", tokenId);
          if (!token) { tokenData.push({ tokenId: tokenId, error: "Token not found" }); return; }

          let initBonus = 0;
          let charId = token.get("represents");
          if (charId) {
            for (let i = 0; i < initAttrNames.length; i++) {
              let attrs = findObjs({ _type: "attribute", _characterid: charId, name: initAttrNames[i] });
              if (attrs.length > 0) {
                let val = parseInt(attrs[0].get("current"));
                if (!isNaN(val)) { initBonus = val; break; }
              }
            }
          }
          tokenData.push({ tokenId: tokenId, name: token.get("name"), initBonus: initBonus, charId: charId || "" });
        });

        let validTokens = tokenData.filter(function(t) { return !t.error; });
        if (!validTokens.length) { writeResult(rollNonce, tokenData); break; }

        // Build one inline roll expression per token: "Name: [[1d20+bonus]]"
        let msgParts = validTokens.map(function(t) {
          let sign = t.initBonus >= 0 ? "+" : "";
          return t.name + ": [[1d20" + (t.initBonus !== 0 ? sign + t.initBonus : "") + "]]";
        });

        sendChat("Initiative", msgParts.join(" | "), function(ops) {
          let inlinerolls = (ops && ops[0] && ops[0].inlinerolls) ? ops[0].inlinerolls : [];

          let rollResults = validTokens.map(function(t, i) {
            let roll = inlinerolls[i];
            let d20 = 1, total = 1 + t.initBonus;
            if (roll) {
              total = roll.results.total;
              // First roll group is the d20
              let firstGroup = roll.results.rolls && roll.results.rolls[0];
              if (firstGroup && firstGroup.type === "R" && firstGroup.results && firstGroup.results[0]) {
                d20 = firstGroup.results[0].v;
              } else {
                d20 = total - t.initBonus;
              }
            }
            return { tokenId: t.tokenId, name: t.name, d20: d20, initBonus: t.initBonus, total: total };
          });

          // Announce public entries via gothic HTML card (all rolled tokens, not just charId).
          if (rollPublic) {
            let publicEntries = rollResults.slice();
            if (publicEntries.length > 0) {
              publicEntries.sort(function(a, b) { return b.total - a.total; });
              let rows = publicEntries.map(function(e, idx) {
                let icon = idx === 0 ? "👑" : "🩸";
                let sign = e.initBonus >= 0 ? "+" : "";
                let displayName = esc(e.name || "");
                let detail = "<span style='color:#6b4040;font-size:0.82em;'> d20(" + e.d20 + ")" + sign + e.initBonus + "</span>";
                return "<tr>"
                  + "<td style='padding:3px 8px;color:#d4a0a0;font-family:Palatino Linotype,Palatino,serif;'>" + icon + " " + displayName + "</td>"
                  + "<td style='padding:3px 8px;color:#ff5555;font-weight:bold;text-align:right;font-family:Palatino Linotype,Palatino,serif;'>" + e.total + detail + "</td>"
                  + "</tr>";
              }).join("");
              let html = "<div style='background:#080204;border:1px solid #5a0000;padding:6px 10px;'>"
                + "<div style='color:#660000;text-align:center;letter-spacing:3px;font-size:0.85em;'>▾ ▼ ▾ ▼ ▾ ▼ ▾</div>"
                + "<div style='color:#cc4444;text-align:center;font-size:1.05em;margin:4px 0;font-family:Palatino Linotype,Palatino,serif;'>🪶 𝔗𝔥𝔢 𝔇𝔢𝔞𝔡'𝔰 𝔇𝔯𝔞𝔴 🪶</div>"
                + "<table style='width:100%;border-collapse:collapse;margin:4px 0;'>" + rows + "</table>"
                + "<div style='color:#4a0000;text-align:center;font-size:0.85em;margin-top:4px;'>— ✦ —</div>"
                + "</div>";
              sendChat("Initiative", "/direct " + html);
            }
          }

          writeResult(rollNonce, rollResults.concat(tokenData.filter(function(t) { return t.error; })));
        }, { noarchive: true });
        break;
      }

      case "advanceTurn": {
        let order = Campaign().get("turnorder");
        if (!order) { writeResult(nonce, { ok: false, note: "Turn order is empty" }); break; }
        let entries = JSON.parse(order);
        if (entries.length === 0) { writeResult(nonce, { ok: false, note: "Turn order is empty" }); break; }
        // Rotate: move first entry to end
        entries.push(entries.shift());
        Campaign().set("turnorder", JSON.stringify(entries));
        let current = entries[0];
        let currentToken = current.id ? getObj("graphic", current.id) : null;
        writeResult(nonce, {
          ok: true,
          current: {
            id: current.id,
            pr: current.pr,
            custom: current.custom,
            name: currentToken ? currentToken.get("name") : (current.custom || "?"),
          },
        });
        break;
      }

      case "getTokenById": {
        // Single implementation lives in runBatchOp (rich token shape).
        writeResult(nonce, runBatchOp("getTokenById", args));
        break;
      }

      case "setTokenProps": {
        // Single implementation lives in runBatchOp.
        writeResult(nonce, runBatchOp("setTokenProps", args));
        break;
      }

      case "getRecentChat": {
        let n = Math.min(args.limit || 50, CHAT_BUFFER.length);
        writeResult(nonce, CHAT_BUFFER.slice(-n));
        break;
      }

      case "getDmInbox": {
        let inbox = B().dmInbox;
        let inboxEntries = args.type
          ? inbox.filter(function(e) { return e.type === args.type; })
          : inbox.slice();
        writeResult(nonce, inboxEntries);
        break;
      }

      case "clearDmInbox": {
        let bs = B();
        if (args.playerName) {
          bs.dmInbox = bs.dmInbox.filter(function(e) { return e.who !== args.playerName; });
        } else {
          bs.dmInbox = [];
        }
        writeResult(nonce, { ok: true });
        break;
      }

      case "setMobPlan": {
        if (!args.tokenId) throw new Error("setMobPlan requires tokenId");
        let plans = B().mobPlans;
        if (args.html) {
          // Store structured plan alongside HTML so callers (gem HUD, etc.) can read
          // the plaintext without parsing the Roll20 template card.
          plans[args.tokenId] = { html: args.html, plan: args.plan || null };
        } else {
          delete plans[args.tokenId];
        }
        writeResult(nonce, { ok: true });
        break;
      }

      case "getMobPlans": {
        // Read all stored mob plans. Plans persist until overwritten by a fresh
        // plan_all_tactics run (they are NOT deleted when the token's turn fires).
        writeResult(nonce, B().mobPlans || {});
        break;
      }

      case "clearMobPlans": {
        B().mobPlans = {};
        writeResult(nonce, { ok: true });
        break;
      }

      case "whisperPlayer": {
        if (!args.playerName || !args.message) throw new Error("whisperPlayer requires playerName and message");
        // Player-facing whisper: must be VISIBLE to the recipient, so (1) archive it (noarchive
        // false) — a noarchive whisper flashes once and is gone, and a player not watching that
        // instant never sees it; and (2) speak as a player-visible identity, NOT "GM-AI-Bridge",
        // whose output the campaign's bridge-suppression CSS hides. The AIBRIDGE_RESULT to the GM
        // (writeResult below) stays hidden as before.
        var whisperSpeaker = args.speakAs || "The DM";
        sendChat(whisperSpeaker, "/w " + args.playerName + " " + args.message, null, { noarchive: false });
        writeResult(nonce, { ok: true });
        break;
      }

      case "findTokensInRange": {
        let centerToken = getObj("graphic", args.centerTokenId);
        if (!centerToken) throw new Error("Center token not found: " + args.centerTokenId);
        let pageId = args.pageId || centerToken.get("_pageid");
        let page = getObj("page", pageId);
        if (!page) throw new Error("Page not found: " + pageId);
        let scaleNumber = page.get("scale_number") || 5;
        let pixelsPerFoot = 70 / scaleNumber;
        let cx = centerToken.get("left");
        let cy = centerToken.get("top");
        let radiusFeet = args.radiusFeet || 15;
        let radiusPx = radiusFeet * pixelsPerFoot;
        let allTokens = findObjs({ _type: "graphic", _pageid: pageId });
        let rangeResults = [];
        allTokens.forEach(function(t) {
          if (t.id === args.centerTokenId) return;
          if (args.layerFilter && t.get("layer") !== args.layerFilter) return;
          let dx = t.get("left") - cx;
          let dy = t.get("top") - cy;
          let distPx = Math.sqrt(dx * dx + dy * dy);
          let distFeet = distPx / pixelsPerFoot;
          if (distFeet <= radiusFeet) {
            rangeResults.push({
              id: t.id,
              name: t.get("name"),
              layer: t.get("layer"),
              distanceFeet: Math.round(distFeet * 10) / 10,
              bar1_value: t.get("bar1_value"),
              bar1_max: t.get("bar1_max"),
              controlledby: t.get("controlledby") || "",
            });
          }
        });
        rangeResults.sort(function(a, b) { return a.distanceFeet - b.distanceFeet; });
        writeResult(nonce, rangeResults);
        break;
      }

      case "setTurnHook": {
        let bs = B();
        bs.turnHookEnabled = !!args.enabled;
        if (args.reset) { bs.round = 0; }
        writeResult(nonce, { ok: true, enabled: bs.turnHookEnabled, round: bs.round });
        break;
      }

      case "getTurnHookState": {
        let bs = B();
        writeResult(nonce, { enabled: bs.turnHookEnabled, round: bs.round });
        break;
      }

      case "setCharacterAttributes": {
        // Write attributes to a Roll20 character sheet (charId = the `represents` field from the token).
        // args.attributes values can be plain scalars (sets current only) or { current, max } objects.
        // NOTE: findObjs uses _characterid (underscore), but createObj requires characterid (no underscore).
        let charId = args.charId;
        let attributes = args.attributes || {};
        let updated = [], created = [], failed = [];
        Object.keys(attributes).forEach(function(attrName) {
          let val = attributes[attrName];
          let isObj = typeof val === "object" && val !== null;
          let currentVal = isObj ? val.current : val;
          let maxVal = isObj ? val.max : undefined;
          let existing = findObjs({ _type: "attribute", _characterid: charId, name: attrName });
          if (existing.length > 0) {
            let updates = {};
            if (currentVal !== undefined) updates.current = currentVal;
            if (maxVal !== undefined) updates.max = maxVal;
            existing[0].set(updates);
            updated.push(attrName);
          } else {
            let createArgs = { characterid: charId, name: attrName };
            if (currentVal !== undefined) createArgs.current = currentVal;
            if (maxVal !== undefined) createArgs.max = maxVal;
            let obj = createObj("attribute", createArgs);
            if (obj) { created.push(attrName); } else { failed.push(attrName); }
          }
        });
        writeResult(nonce, { updated: updated, created: created, failed: failed });
        break;
      }

      case "getCharacterAttributes": {
        // Read attributes from a Roll20 character sheet. Pass names[] to filter.
        let charId = args.charId;
        let nameFilter = args.names;
        let attrs = findObjs({ _type: "attribute", _characterid: charId });
        let result = {};
        attrs.forEach(function(a) {
          let attrName = a.get("name");
          if (!nameFilter || nameFilter.indexOf(attrName) !== -1) {
            result[attrName] = { current: a.get("current"), max: a.get("max") };
          }
        });
        writeResult(nonce, result);
        break;
      }

      case "getRepeatingSection": {
        // Returns all rows of a repeating section from a character sheet.
        // args.charId, args.section (e.g. "npcaction")
        // Result: { [rowId]: { [fieldName]: value } }  (macro-syntax values skipped)
        if (!args.charId || !args.section) throw new Error("getRepeatingSection requires charId and section");
        let repAttrs = findObjs({ _type: "attribute", _characterid: args.charId });
        let prefix = "repeating_" + args.section + "_";
        let rows = {};
        repAttrs.forEach(function(a) {
          let name = a.get("name");
          if (name.indexOf(prefix) !== 0) return;
          let rest = name.slice(prefix.length);
          let sep = rest.indexOf("_");
          if (sep === -1) return;
          let rowId = rest.slice(0, sep);
          let field = rest.slice(sep + 1);
          let val = String(a.get("current") || "");
          // Skip Roll20 macro syntax — sendChat would try to resolve @{...} and error
          if (val.indexOf("@{") !== -1) return;
          if (!rows[rowId]) rows[rowId] = {};
          rows[rowId][field] = val;
        });
        // Cap very long sections (a caster's full spell list) — keep context bounded.
        let maxRows = args.maxRows || 60;
        let rowIds = Object.keys(rows);
        if (rowIds.length > maxRows) {
          let capped = {};
          rowIds.slice(0, maxRows).forEach(function(id) { capped[id] = rows[id]; });
          capped.__truncated = rowIds.length;
          writeResult(nonce, capped);
        } else {
          writeResult(nonce, rows);
        }
        break;
      }

      case "syncConditionsToToken": {
        // Set all status markers on a token and store active_conditions on the character.
        // args.tokenId, args.charId (optional), args.conditions: string[]
        let token = getObj("graphic", args.tokenId);
        if (!token) throw new Error("Token not found: " + args.tokenId);
        let activeSet = new Set((args.conditions || []).map(function(c) { return c.toLowerCase(); }));
        let markerSet = new Set((token.get("statusmarkers") || "").split(",").filter(Boolean));
        // Build set of all known marker strings in every format (Name::id, Name, name)
        // so stale plain-name versions left from prior attempts get cleaned up.
        let allKnown = new Set();
        Object.keys(CONDITION_MARKERS).forEach(function(condition) {
          let tag = CONDITION_MARKERS[condition];
          allKnown.add(tag);
          let displayName = tag.split("::")[0];
          allKnown.add(displayName);
          allKnown.add(displayName.toLowerCase());
        });
        allKnown.forEach(function(m) { markerSet.delete(m); });
        // Re-add only active conditions with correct Name::id tags
        activeSet.forEach(function(condition) {
          let marker = CONDITION_MARKERS[condition];
          if (marker) markerSet.add(marker);
        });
        token.set("statusmarkers", Array.from(markerSet).join(","));
        if (args.charId) setConditionAttr(args.charId, activeSet);
        writeResult(nonce, { ok: true, conditions: Array.from(activeSet), markers: Array.from(markerSet) });
        break;
      }

      case "toggleCondition": {
        // Toggle a single condition on a token sticker and character attribute.
        // args.tokenId, args.charId (optional), args.condition: string, args.active: boolean
        let token = getObj("graphic", args.tokenId);
        if (!token) throw new Error("Token not found: " + args.tokenId);
        let condition = (args.condition || "").toLowerCase();
        let res = resolveMarkerForState(condition);
        let marker = res.tag;
        let markerSet = new Set((token.get("statusmarkers") || "").split(",").filter(Boolean));
        if (args.active) markerSet.add(marker); else markerSet.delete(marker);
        token.set("statusmarkers", Array.from(markerSet).join(","));
        // Tier 1a (true conditions) tracks on the character's active_conditions attr.
        if (res.tier === "condition" && args.charId) {
          let existing = findObjs({ _type: "attribute", _characterid: args.charId, name: "active_conditions" });
          let condList = existing.length > 0 ? (existing[0].get("current") || "").split(",").filter(Boolean) : [];
          let condSet = new Set(condList);
          if (args.active) condSet.add(condition); else condSet.delete(condition);
          setConditionAttr(args.charId, condSet);
        }
        // Tier 2 (ad-hoc) tracks which tokens hold the named state in campaign state.
        if (res.tier === "custom") trackCustomState(res.key, marker, args.tokenId, !!args.active);
        writeResult(nonce, { ok: true, condition: condition, active: !!args.active, marker: marker, tier: res.tier });
        break;
      }

      case "getTokenMarkers": {
        let raw = Campaign().get("token_markers");
        let markers = typeof raw === "string" ? JSON.parse(raw) : (raw || []);
        writeResult(nonce, markers.map(function(m) {
          return { id: m.id, name: m.name, tag: m.tag };
        }));
        break;
      }

      case "getCustomStates": {
        // Tier-2 ad-hoc states the DM is tracking: name -> icon + which tokens hold it.
        let cs = B().customStates || {};
        let out = Object.keys(cs).map(function (name) {
          let entry = cs[name] || {};
          let holders = (entry.tokens || []).map(function (id) {
            let g = getObj("graphic", id);
            return { id: id, name: g ? (g.get("name") || "") : "(missing)" };
          });
          return { state: name, tag: entry.tag, tokens: holders };
        });
        writeResult(nonce, out);
        break;
      }

      case "rollFormulas": {
        // Roll each formula for real but WITH a callback, so the raw Roll20 roll stays hidden — we only
        // want the numbers. Then we post our OWN parchment card showing the real total + dice in ink.
        // This avoids the uncolorable purple Roll20 inline-roll chip entirely, so the card looks fully
        // "written on parchment". silent → the card is whispered to the GM.
        let rollNonce = nonce;
        let items = args.items || [];
        if (!items.length) { writeResult(rollNonce, []); break; }
        let defaultSpeaker = args.speakAs || "The Bones";
        let silent = args.silent === true;
        let rollResults = new Array(items.length);
        let rollRemaining = items.length;
        let rollDone = false;
        function finishRolls() {
          if (rollDone) return;
          rollDone = true;
          writeResult(rollNonce, rollResults);
        }
        items.forEach(function(item, idx) {
          sendChat(defaultSpeaker, "/roll " + item.formula, function(ops) {
            var total = 0, dice = [];
            try {
              var pr = JSON.parse(ops[0].content);
              total = pr.total;
              (pr.rolls || []).forEach(function(r) { if (r.type === "R") (r.results || []).forEach(function(d) { dice.push(d.v); }); });
            } catch (e) {}
            rollResults[idx] = { label: item.label || "", formula: item.formula, total: total, dice: dice };

            // nat-20 / nat-1 ink color for single d20 rolls
            var inkTotal = "#2d1705";
            if (dice.length === 1 && /d20/i.test(item.formula)) {
              if (dice[0] === 20) inkTotal = "#0f5510";
              else if (dice[0] === 1) inkTotal = "#7a0d0d";
            }
            var bd = dice.length
              ? "<div style=\"color:#553913;font-size:0.72em;letter-spacing:0.06em;margin-top:4px;\">⚄ " + dice.join("&nbsp;·&nbsp;") + "</div>"
              : "";
            // Aged parchment: a SOLID opaque base color (so darkmode never shows through even if the
            // sanitizer drops the gradient layers) with subtle mottling painted on via background-image.
            var card = "<div style=\"background-color:#f3e6c4;"
              + "background-image:radial-gradient(ellipse at 20% 25%,rgba(150,112,62,0.20),transparent 55%),"
              + "radial-gradient(ellipse at 82% 78%,rgba(120,88,45,0.18),transparent 55%);"
              + "border:1px solid #8a6a38;border-radius:5px;padding:9px 20px 11px;min-width:118px;text-align:center;"
              + "font-family:'Palatino Linotype',Palatino,'Book Antiqua',serif;display:inline-block;"
              + "box-shadow:inset 0 0 18px rgba(110,80,35,0.22),0 1px 3px rgba(0,0,0,0.45);\">"
              + "<div style=\"color:#3d2407;font-size:0.82em;letter-spacing:0.1em;font-variant:small-caps;font-weight:bold;font-style:italic;margin:0 0 2px;\">🎲 " + esc(item.formula) + "</div>"
              + "<div style=\"color:" + inkTotal + ";font-weight:bold;font-size:2em;line-height:1.05;\">" + total + "</div>"
              + bd
              + "</div>";
            sendChat(item.label || defaultSpeaker, (silent ? "/w gm " : "") + card, null, { noarchive: false });

            rollRemaining--;
            if (rollRemaining === 0) finishRolls();
          });
        });
        // Safety: if a callback never fires (bad formula, etc.), don't hang the relay — time out.
        setTimeout(function() {
          if (rollDone) return;
          for (var i = 0; i < items.length; i++) {
            if (!rollResults[i]) rollResults[i] = { label: items[i].label || "", formula: items[i].formula, total: 0, dice: [], error: "no roll result (timeout)" };
          }
          finishRolls();
        }, 4000);
        break;
      }

      case "sendNarration": {
        // Send styled narrative text to Roll20 chat, visible to all players.
        // style: "narration" (default) | "combat" | "dramatic" | "ambient"
        let narText = args.text || "";
        let narStyle = args.style || "narration";
        let narSpeaker = args.speakAs || "The Dark Powers";

        let styles = {
          narration: "font-family:Georgia,serif;font-style:italic;color:#e8c97e;border:1px solid #7a3030;border-left-width:3px;padding:7px 12px;background:#1c0808;line-height:1.65;border-radius:2px;",
          combat:    "font-family:Georgia,serif;font-weight:bold;color:#f08080;border:1px solid #8b0000;border-left-width:3px;padding:7px 12px;background:#200a0a;line-height:1.65;border-radius:2px;",
          dramatic:  "font-family:Georgia,serif;font-weight:bold;font-style:italic;color:#e8c040;text-align:center;border:1px solid #8b6914;border-top-width:2px;border-bottom-width:2px;padding:10px 14px;background:#1a1100;letter-spacing:0.5px;line-height:1.7;border-radius:2px;",
          ambient:   "font-family:Georgia,serif;font-style:italic;color:#a8c890;border:1px solid #4a6a3a;border-left-width:3px;padding:7px 12px;background:#080f08;line-height:1.65;border-radius:2px;",
        };
        let styleStr = styles[narStyle] || styles.narration;
        let html = "<div style='" + styleStr + "'>" + narText + "</div>";
        sendChat(narSpeaker, html, null, {});
        writeResult(nonce, { ok: true });
        break;
      }

      case "batchExec": {
        // Execute N sync operations in a single relay round-trip.
        // Each op: { id?, action, args? }
        // Returns: [{ id, ok, data?, error? }]
        let batchOps = args.ops || [];
        let batchResults = [];
        batchOps.forEach(function(op) {
          let opId = (op.id != null) ? op.id : batchResults.length;
          try {
            let data = runBatchOp(op.action, op.args || {});
            batchResults.push({ id: opId, ok: true, data: data });
          } catch(e) {
            batchResults.push({ id: opId, ok: false, error: String(e) });
          }
        });
        writeResult(nonce, batchResults);
        break;
      }

      case "ping": {
        writeResult(nonce, { pong: true, version: "2.1.0" });
        break;
      }

      case "createZone": {
        // Draw a named zone (circle or rect) on the "objects" layer.
        // Metadata stored in gmnotes so it survives relay restarts.
        // centerX/centerY in page pixels; radiusFeet converted via page scale.
        let zonePage = getObj("page", args.pageId);
        if (!zonePage) throw new Error("Page not found: " + args.pageId);
        let zoneScale = args.scaleNumber || zonePage.get("scale_number") || 5;
        let zoneRadiusPx = (args.radiusFeet || 15) * (70 / zoneScale);
        let zoneCx = args.centerX || 0;
        let zoneCy = args.centerY || 0;
        let zoneColor = args.color || "#aa00ff";
        let zoneName = "ZONE: " + (args.name || "Zone");

        let zonePath, zoneWidth, zoneHeight;
        if ((args.shape || "circle") === "rect") {
          // Rectangle: width/height passed directly in feet, converted to pixels
          let halfW = (args.widthFeet || args.radiusFeet || 15) * (70 / zoneScale) / 2;
          let halfH = (args.heightFeet || args.radiusFeet || 15) * (70 / zoneScale) / 2;
          zoneWidth = halfW * 2;
          zoneHeight = halfH * 2;
          zonePath = JSON.stringify([["M",0,0],["L",zoneWidth,0],["L",zoneWidth,zoneHeight],["L",0,zoneHeight],["Z"]]);
        } else {
          zonePath = makeCirclePath(zoneRadiusPx);
          zoneWidth = zoneRadiusPx * 2;
          zoneHeight = zoneRadiusPx * 2;
        }

        let zoneObj = createObj("path", {
          pageid: args.pageId,
          layer: "map",
          path: zonePath,
          left: zoneCx,
          top: zoneCy,
          width: zoneWidth,
          height: zoneHeight,
          rotation: 0,
          stroke: zoneColor,
          stroke_width: 3,
          fill: zoneColor,
          fill_opacity: 0.25,
          scaleX: 1,
          scaleY: 1,
          controlledby: "",
        });
        if (!zoneObj) throw new Error("Failed to create zone path object");
        zoneObj.set("name", zoneName);
        zoneObj.set("gmnotes", JSON.stringify({
          zone: true,
          name: args.name || "Zone",
          shape: args.shape || "circle",
          centerX: zoneCx,
          centerY: zoneCy,
          radiusFeet: args.radiusFeet || 15,
          color: zoneColor,
        }));
        writeResult(nonce, { id: zoneObj.id, name: zoneName, radiusFeet: args.radiusFeet || 15, centerX: zoneCx, centerY: zoneCy });
        break;
      }

      case "clearZone": {
        if (args.zoneId) {
          let zo = getObj("path", args.zoneId);
          if (zo) zo.remove();
          writeResult(nonce, { removed: zo ? 1 : 0 });
        } else if (args.name) {
          let prefix = "ZONE: " + args.name;
          let found = findObjs({ _type: "path", _pageid: args.pageId }).filter(function(p) {
            return p.get("name") === prefix;
          });
          found.forEach(function(p) { p.remove(); });
          writeResult(nonce, { removed: found.length });
        } else {
          throw new Error("clearZone requires zoneId or name");
        }
        break;
      }

      case "removeObject": {
        // Remove any Roll20 object by id. Tries graphic, then path.
        let roObj = getObj(args.objectType || "graphic", args.objectId);
        if (!roObj && (!args.objectType || args.objectType === "graphic")) roObj = getObj("path", args.objectId);
        if (!roObj) throw new Error("Object not found: " + args.objectId);
        roObj.remove();
        writeResult(nonce, { ok: true, id: args.objectId });
        break;
      }

      case "listZones": {
        let allPaths = findObjs({ _type: "path", _pageid: args.pageId });
        let zones = allPaths.filter(function(p) {
          return (p.get("name") || "").startsWith("ZONE: ");
        }).map(function(p) {
          let meta = {};
          try { meta = JSON.parse(p.get("gmnotes") || "{}"); } catch(e) {}
          return {
            id: p.id,
            name: p.get("name"),
            left: p.get("left"),
            top: p.get("top"),
            meta: meta,
          };
        });
        writeResult(nonce, zones);
        break;
      }

      case "findTokensInZone": {
        // Load zone metadata from gmnotes, then check all tokens for containment.
        let zoneGraphic = getObj("path", args.zoneId);
        if (!zoneGraphic) throw new Error("Zone not found: " + args.zoneId);
        let zoneMeta = {};
        try { zoneMeta = JSON.parse(zoneGraphic.get("gmnotes") || "{}"); } catch(e) {}
        let zCx = zoneMeta.centerX != null ? zoneMeta.centerX : zoneGraphic.get("left");
        let zCy = zoneMeta.centerY != null ? zoneMeta.centerY : zoneGraphic.get("top");
        let zRadFeet = zoneMeta.radiusFeet || 15;
        let zPage = getObj("page", args.pageId || zoneGraphic.get("_pageid"));
        if (!zPage) throw new Error("Page not found");
        let zScale = zPage.get("scale_number") || 5;
        let zPxPerFoot = 70 / zScale;
        let zRadPx = zRadFeet * zPxPerFoot;
        let zTokens = findObjs({ _type: "graphic", _pageid: zPage.id });
        let inZone = [];
        zTokens.forEach(function(t) {
          let dx = t.get("left") - zCx;
          let dy = t.get("top") - zCy;
          let distPx = Math.sqrt(dx * dx + dy * dy);
          if (distPx <= zRadPx) {
            inZone.push({
              id: t.id,
              name: t.get("name"),
              layer: t.get("layer"),
              distanceFeet: Math.round((distPx / zPxPerFoot) * 10) / 10,
              bar1_value: t.get("bar1_value"),
              bar1_max: t.get("bar1_max"),
            });
          }
        });
        inZone.sort(function(a, b) { return a.distanceFeet - b.distanceFeet; });
        writeResult(nonce, inZone);
        break;
      }

      case "getJournalFolder": {
        let rawJf = Campaign().get("_journalfolder");
        writeResult(nonce, rawJf ? JSON.parse(rawJf) : []);
        break;
      }

      case "setJournalFolder": {
        // Two modes:
        //  - args.json = a full array -> replace the whole _journalfolder tree.
        //  - args.json = { __append__: [folder, ...] } -> read the LIVE tree and push
        //    those folders/ids onto the end (safe merge; never clobbers existing).
        if (args.json && !Array.isArray(args.json) && args.json.__append__) {
          let rawJf = Campaign().get("_journalfolder");
          let tree = rawJf ? JSON.parse(rawJf) : [];
          args.json.__append__.forEach(function(f) { tree.push(f); });
          Campaign().set("_journalfolder", JSON.stringify(tree));
          writeResult(nonce, { ok: true, appended: args.json.__append__.length, total: tree.length });
        } else {
          Campaign().set("_journalfolder", JSON.stringify(args.json || []));
          writeResult(nonce, { ok: true });
        }
        break;
      }

      case "createHandout": {
        // Single implementation lives in runBatchOp.
        // Full-page journal handout. notes = player-visible HTML, gmnotes = GM-only.
        // inplayerjournals "all" shares with players. avatar = Roll20 CDN url.
        writeResult(nonce, runBatchOp("createHandout", args));
        break;
      }

      case "createCharacter": {
        // Single implementation lives in runBatchOp.
        // Bestiary stub: a character entry (draggable token). attributes = [{name,current,max}].
        writeResult(nonce, runBatchOp("createCharacter", args));
        break;
      }

      default:
        throw new Error(`Unknown action: ${action}`);
    }
  } catch (err) {
    writeResult(nonce, null, err.message || String(err));
  }
});

// Build a reverse map from marker tag → condition name (for statusmarkers → condition names).
function buildMarkerToCondition() {
  let map = {};
  Object.keys(CONDITION_MARKERS).forEach(function(cond) {
    map[CONDITION_MARKERS[cond]] = cond;
  });
  return map;
}

// Read combatant status for a turn order entry. Returns a display string.
function combatantStatusLine(entry) {
  if (!entry || !entry.id) return null;
  let t = getObj("graphic", entry.id);
  if (!t) return null;
  let name = t.get("name") || "?";
  let eff = effectiveHp(t);
  let hp = eff.hp;
  let maxHp = eff.maxHp;
  let markerMap = buildMarkerToCondition();
  let markers = (t.get("statusmarkers") || "").split(",").filter(Boolean);
  let conditions = markers.map(function(m) { return markerMap[m]; }).filter(Boolean);
  // De-duplicate (dead/unconscious share a marker)
  let condSet = {};
  conditions.forEach(function(c) { condSet[c] = true; });
  let condStr = Object.keys(condSet).join(", ") || "—";
  let bar = "";
  if (maxHp) {
    let filled = Math.round((hp / maxHp) * 10);
    bar = "█".repeat(Math.max(0, filled)) + "░".repeat(Math.max(0, 10 - filled)) + " ";
  }
  return "<b>" + esc(name) + "</b> " + bar + "— " + condStr;
}

on("change:campaign:turnorder", function(obj, prev) {
  let bs = B();
  if (!bs.turnHookEnabled) return;

  let rawNew = obj.get("turnorder");
  let rawOld = prev ? prev["turnorder"] : null;
  if (!rawNew) return;

  let newOrder;
  try { newOrder = JSON.parse(rawNew); } catch(e) { return; }
  if (!newOrder || newOrder.length === 0) return;

  let newFirst = newOrder[0];
  if (!newFirst || !newFirst.id) return;

  // Detect actual turn advancement (first entry changed)
  let oldFirstId = null;
  let oldFirstPr = null;
  if (rawOld) {
    try {
      let oldOrder = JSON.parse(rawOld);
      oldFirstId = (oldOrder[0] || {}).id || null;
      oldFirstPr = oldOrder[0] ? Number(oldOrder[0].pr) : null;
    } catch(e) {}
  }
  if (oldFirstId === newFirst.id) return;

  let currentPr = Number(newFirst.pr);

  // Round detection: initiative wrapped when current pr > the pr of the token that just finished.
  // No token-ID tracking — works correctly regardless of late joiners, rerolls, or deaths.
  if (bs.round === 0) {
    bs.round = 1;
  } else if (oldFirstPr !== null && currentPr > oldFirstPr) {
    // Wrapped — end of previous round, start of new
    let summaryLines = newOrder.map(function(e) { return combatantStatusLine(e); }).filter(Boolean);
    let summaryHtml = "<div style='background:#080204;border:1px solid #3a0000;padding:6px 10px;'>"
      + "<div style='color:#cc4444;font-family:\"Palatino Linotype\",Palatino,serif;text-align:center;font-size:1em;margin-bottom:4px;'>⚔ Round " + bs.round + " Complete</div>"
      + summaryLines.map(function(r) {
          return "<div style='color:#d4a0a0;font-family:\"Palatino Linotype\",Palatino,serif;font-size:0.9em;padding:1px 4px;'>" + r + "</div>";
        }).join("")
      + "</div>";
    sendChat("GM-AI-Bridge", summaryHtml, null, { noarchive: false });
    bs.round++;
  }

  // Post turn announcement
  let token = getObj("graphic", newFirst.id);
  let name = token ? token.get("name") : (newFirst.custom || "?");
  let eff = token ? effectiveHp(token) : { hp: null, maxHp: null, note: null };
  let hp = eff.hp;
  let maxHp = eff.maxHp;
  let markerMap = buildMarkerToCondition();
  let markers = token ? (token.get("statusmarkers") || "").split(",").filter(Boolean) : [];
  let condSet = {};
  markers.forEach(function(m) { let c = markerMap[m]; if (c) condSet[c] = true; });
  let conditions = Object.keys(condSet);

  // Check the persisted DM inbox for a preloaded intent from this token's controller
  let pendingIntent = null;
  if (token) {
    let controlled = token.get("controlledby") || "";
    let controllerIds = controlled.split(",").map(function(s){ return s.trim(); }).filter(Boolean);
    let inbox = bs.dmInbox;
    for (let di = 0; di < inbox.length; di++) {
      if (inbox[di].type === "intent" && controllerIds.indexOf(inbox[di].playerid) !== -1) {
        pendingIntent = inbox[di];
        inbox.splice(di, 1);
        break;
      }
    }
  }

  // Show the stored mob tactical plan for this token (persists — not deleted here;
  // overwritten by the next plan_all_tactics run).
  let mobPlan = bs.mobPlans[newFirst.id] || null;

  let hpLine = "";
  if (maxHp) {
    let filled = Math.round((hp / maxHp) * 10);
    let bar = "█".repeat(Math.max(0, filled)) + "░".repeat(Math.max(0, 10 - filled));
    hpLine = "<div style='color:#d4a0a0;font-size:0.85em;font-family:monospace;'>" + bar + "</div>";
  }
  // Subtle note when a PC's Beyond20-owned token bar disagrees with our tracked HP.
  if (eff.note) {
    hpLine += "<div style='color:#6b5a3a;font-size:0.68em;font-style:italic;'>tracked "
      + eff.note.tracked + (eff.note.max ? "/" + eff.note.max : "")
      + " · token bar " + eff.note.tokenBar + "</div>";
  }
  let condLine = conditions.length > 0
    ? "<div style='color:#bb8888;font-size:0.85em;'>Conditions: " + conditions.join(", ") + "</div>"
    : "";
  let intentLine = pendingIntent
    ? "<div style='color:#aaddaa;font-size:0.85em;margin-top:4px;'>📋 " + esc(pendingIntent.who) + " intends: " + esc(pendingIntent.content) + "</div>"
    : "";

  let html = "<div style='background:#080204;border-left:3px solid #cc4444;padding:5px 10px;'>"
    + "<div style='color:#cc4444;font-family:\"Palatino Linotype\",Palatino,serif;font-size:1em;'>🩸 <b>" + esc(name) + "</b> — Round " + bs.round + "</div>"
    + hpLine + condLine + intentLine
    + "</div>";
  sendChat("Initiative", html, null, { noarchive: false });

  if (mobPlan) {
    sendChat("GM-AI-Bridge", "/w gm " + mobPlan.html, null, { noarchive: true });
  }
});

on("ready", function() {
  let bs = B();
  log("[GM_AI_Bridge] Relay ready. State restored from `state` — round=" + bs.round
    + " turnHook=" + bs.turnHookEnabled + " inbox=" + bs.dmInbox.length
    + " plans=" + Object.keys(bs.mobPlans).length);
});

log("[GM_AI_Bridge] Relay script loaded. Ready for !ai-relay commands.");
