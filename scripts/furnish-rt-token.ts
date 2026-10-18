// Furnish roll20-rt-token.json by hand — the no-gem path (#177 keeps harvesting out of the server).
//
// A human copies the Firebase custom token out of their OWN logged-in Roll20 editor tab (DevTools,
// see docs/setup-guide.md §5); this script validates it and writes the file the server reads. It
// opens no browser and mints nothing — it only checks what it was handed:
//
//   1. the pasted text contains a Firebase custom token (any paste works: the bare token, the
//      request payload JSON, or DevTools "Copy as cURL"/"Copy as fetch" — the JWT is extracted);
//   2. the token still exchanges, and the resulting ID token's `currentcampaign` claim is THIS
//      campaign (tokens are campaign-scoped) and `is_gm` is true (the relay is GM-only);
//   3. the databaseURL is the campaign's real RTDB shard — a wrong shard reads empty, which the
//      server would otherwise discover as a silent no-op much later.
//
// harvestedAt is the token's own `iat`, not "now", so transport_status reports a true age. Age is
// not refused here, mirroring the server (#216): Firebase's answer to the exchange is the verdict.
//
//   Get-Clipboard | npm run furnish:token -- --campaign 22125197 --db roll20-99913
//   npx tsx scripts/furnish-rt-token.ts --db https://roll20-99913.firebaseio.com   (prompts; active campaign)
//
// Writes <ROLL20_DATA_DIR>/roll20-rt-token.json (default ./data) — the same dir the server you'll
// start reads. --print instead emits the JSON on stdout for ROLL20_RT_TOKEN, which overrides the
// file (useful for a stdio maps server or a script with no shared data dir).
import { writeFileSync, renameSync, mkdirSync } from "fs";
import path from "path";
import { createInterface } from "readline";
import { initializeApp, deleteApp } from "firebase/app";
import { getAuth, signInWithCustomToken } from "firebase/auth";
import { FIREBASE_CONFIG } from "../src/bridge/roll20-rt.js";
import { getActiveCampaign } from "../src/registry/campaigns.js";
import { dataPath } from "../src/dataDir.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function fail(msg: string): never {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}

async function readPaste(): Promise<string> {
  if (!process.stdin.isTTY) {
    let s = "";
    for await (const chunk of process.stdin) s += chunk;
    return s;
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const line = await new Promise<string>((r) => rl.question("Paste the signInWithCustomToken token (or the whole request), then Enter:\n", r));
  rl.close();
  return line;
}

function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  try { return JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf-8")); }
  catch { return null; }
}

// A Firebase custom token's audience is the Identity Toolkit — that's what tells it apart from
// any other JWT that might ride along in a copied cURL (an ID token, a Roll20 OAuth token).
const CUSTOM_TOKEN_AUD = "https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit";

interface Extracted { token: string; iat: number; exp: number | null; claims: Record<string, unknown> }

function extractCustomToken(paste: string): Extracted {
  const jwts = paste.match(/eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+/g) ?? [];
  for (const jwt of jwts) {
    const p = decodeJwtPayload(jwt);
    if (p?.aud === CUSTOM_TOKEN_AUD && typeof p.iat === "number") {
      return { token: jwt, iat: p.iat, exp: typeof p.exp === "number" ? p.exp : null, claims: (p.claims ?? {}) as Record<string, unknown> };
    }
  }
  fail(
    jwts.length
      ? `found ${jwts.length} JWT(s) in the paste but none is a Firebase custom token (aud ≠ Identity Toolkit). ` +
        `Copy the "token" field of the signInWithCustomToken request, not the response.`
      : "no JWT in the paste. Copy the \"token\" field from the signInWithCustomToken request payload.",
  );
}

// Roll20 stamps currentcampaign/is_gm onto the custom token itself (the ID token inherits them),
// so the two mistakes people actually make — wrong campaign's tab, a player login — are named
// here before any network call, and even for an expired token.
function checkClaims(claims: Record<string, unknown>, campaignId: string, where: string): string {
  const storagePath = String(claims.currentcampaign ?? "");
  if (!storagePath.startsWith(`campaign-${campaignId}-`)) {
    const other = storagePath.match(/^campaign-(\d+)-/)?.[1];
    fail(
      other
        ? `${where} belongs to campaign ${other}, not ${campaignId}. Tokens are campaign-scoped — copy it from ${campaignId}'s editor.`
        : `${where} carries no currentcampaign claim; this isn't a Roll20 editor session token.`,
    );
  }
  if (claims.is_gm !== true) {
    fail(
      `${where} is a PLAYER session in campaign ${campaignId}. The relay only obeys the GM (senderIsGM), so ` +
      `nothing would work. You must be a GM of the campaign (and the Mod must be installed there, which needs ` +
      `the creator's Pro subscription).`,
    );
  }
  return storagePath;
}

function normalizeDbUrl(v: string): string {
  const s = v.trim().replace(/\/+$/, "");
  if (/^roll20-\d+$/.test(s)) return `https://${s}.firebaseio.com`;
  if (/^https:\/\/roll20-\d+\.firebaseio\.com$/.test(s)) return s;
  fail(`--db must be the RTDB namespace (roll20-99913) or https://roll20-NNNNN.firebaseio.com — got "${v}"`);
}

async function main() {
  const dbArg = arg("db");
  if (!dbArg) fail("--db is required: the editor's window.FIREBASE_ROOT, or the ns= on its firebaseio.com websocket");
  const databaseURL = normalizeDbUrl(dbArg);
  const campaignId = arg("campaign") ?? getActiveCampaign().roll20CampaignId;
  if (!/^\d+$/.test(campaignId)) fail(`--campaign must be the numeric Roll20 campaign id — got "${campaignId}"`);

  const { token, iat, exp, claims: tokenClaims } = extractCustomToken(await readPaste());
  checkClaims(tokenClaims, campaignId, "this token");
  const harvestedAt = iat * 1000;

  // Exchange it exactly as the server will, then read the claims Roll20 put on the ID token.
  const app = initializeApp(FIREBASE_CONFIG, `furnish-${Date.now()}`);
  try {
    let cred;
    try { cred = await signInWithCustomToken(getAuth(app), token); }
    catch (e) {
      const code = (e as { code?: string }).code ?? (e as Error).message;
      const expiredMin = exp !== null && Date.now() >= exp * 1000 ? Math.round((Date.now() - exp * 1000) / 60_000) : null;
      fail(`Firebase rejected the token (${code}).` +
        (expiredMin !== null ? ` It expired ${expiredMin} min ago — grab a fresh one.` : ` It is truncated or not Roll20's.`));
    }
    const { claims, token: idToken } = await cred.user.getIdTokenResult();
    const storagePath = checkClaims(claims, campaignId, "the exchanged ID token");

    // Shard check: the campaign node exists on the right RTDB instance and reads null on any other.
    const res = await fetch(`${databaseURL}/${storagePath}/campaign.json?shallow=true&auth=${encodeURIComponent(idToken)}`);
    if (!res.ok) fail(`RTDB shard check failed (${res.status}) at ${databaseURL}: ${await res.text().catch(() => "")}`);
    if ((await res.json()) == null) {
      fail(`${databaseURL} has no data for campaign ${campaignId} — wrong shard. Read window.FIREBASE_ROOT in that campaign's editor.`);
    }

    const record = { campaignId, customToken: token, databaseURL, harvestedAt };
    const leftMin = exp !== null ? Math.round((exp * 1000 - Date.now()) / 60_000) : null;
    const within = leftMin !== null ? `within ${leftMin} min (the token's own expiry)` : "soon (the token carries no exp)";
    console.error(`✓ campaign ${campaignId} (GM), shard ${databaseURL}`);
    if (process.argv.includes("--print")) {
      process.stdout.write(JSON.stringify(record) + "\n");
      console.error(`✓ printed the ROLL20_RT_TOKEN value above. Start the server with it set ${within}.`);
    } else {
      const file = dataPath("roll20-rt-token.json");
      mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(record), "utf-8");
      renameSync(tmp, file);
      console.error(`✓ wrote ${file}`);
      if (process.env.ROLL20_RT_TOKEN !== undefined) {
        console.error("  ⚠ ROLL20_RT_TOKEN is set in this shell and OVERRIDES that file — unset it.");
      }
      console.error(`  Start (or reconnect) the server ${within}; once connected it stays up for the session.`);
    }
  } finally {
    await deleteApp(app).catch(() => {});
  }
}

main().then(() => process.exit(0), (e) => fail((e as Error).stack ?? String(e)));
