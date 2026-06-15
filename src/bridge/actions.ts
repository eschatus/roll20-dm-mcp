// Shared nonce generator — ONE counter for every relay path (roll20.ts relayCommand and
// roll20-rt.ts direct callers like pingMod). Two independent Date.now()-seeded counters can
// produce overlapping values, and a collision would make the Mod's PROCESSED_NONCES LRU
// dedupe a different command and re-whisper the wrong cached result. Lives here (the
// dependency-free leaf both transports already import) to avoid a circular dependency.
let _nonce = Date.now();
export const newNonce = (): number => ++_nonce;

// Canonical list of read-only relay actions — safe to retry on any transport, no side effects.
// Imported by both roll20.ts and roll20-rt.ts; lives here to avoid a circular dependency.
export const READONLY_ACTIONS = new Set<string>([
  "getTokens", "getSelection", "getTokenById", "getWalls", "debugPage",
  "getPaths", "getDoors", "listPages", "getTurnOrder", "getRecentChat",
  "getDmInbox", "getTurnHookState", "getCharacterAttributes", "getRepeatingSection",
  "getTokenMarkers", "getCustomStates", "listZones", "findTokensInZone",
  "findTokensInRange", "getJournalFolder", "ping",
]);
