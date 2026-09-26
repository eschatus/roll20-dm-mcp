// Regression for #216: the on-disk RT token's AGE must not gate the sign-in.
//
// Only the gem writes roll20-rt-token.json, and only on a full re-harvest — which it performs
// reactively, when its own server hits a token failure. A gem holding a live socket never fails,
// so the file's mtime stops moving while the gem reports perfect health. The server used to
// refuse any cached token older than 50 minutes WITHOUT offering it to Firebase, so every other
// reader of that data dir (roll20-dm-maps over stdio, a tsx script) was locked out with
// "cached token is 56m old (max 50m)" while the credential on disk was still perfectly good.
//
// Firebase is the authority on whether a token is spent. These cases pin the pre-flight read —
// the part that runs BEFORE the exchange — so they need no network: structural problems still
// fail loudly, age never does, and transport_status can see the staleness the gem can't.
//
// TOKEN_CACHE is resolved at module load, so roll20-rt must be imported AFTER the env is set.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const CAMPAIGN = "17883987";
const MIN = 60_000;

const saved = {
  dataDir: process.env.ROLL20_DATA_DIR,
  roll20: process.env.ROLL20_CAMPAIGN_ID,
  ddb: process.env.DDB_CAMPAIGN_ID,
};
const restore = (key: keyof typeof saved, name: string) => {
  if (saved[key] === undefined) delete process.env[name];
  else process.env[name] = saved[key];
};

let tmp: string;
let tokenFile: string;
let rt: typeof import("../src/bridge/roll20-rt.js");

function writeToken(over: Record<string, unknown> = {}): void {
  fs.writeFileSync(tokenFile, JSON.stringify({
    campaignId: CAMPAIGN,
    customToken: "eyJhbGciOiJSUzI1NiJ9.fake-custom-token",
    databaseURL: "https://roll20-9997.firebaseio.com/",
    harvestedAt: Date.now(),
    ...over,
  }));
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rt-token-age-"));
  process.env.ROLL20_DATA_DIR = tmp;
  process.env.ROLL20_CAMPAIGN_ID = CAMPAIGN;
  process.env.DDB_CAMPAIGN_ID = "5201061";
  tokenFile = path.join(tmp, "roll20-rt-token.json");
  rt = await import("../src/bridge/roll20-rt.js");
});

afterAll(() => {
  restore("dataDir", "ROLL20_DATA_DIR");
  restore("roll20", "ROLL20_CAMPAIGN_ID");
  restore("ddb", "DDB_CAMPAIGN_ID");
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => { fs.rmSync(tokenFile, { force: true }); });

describe("the cached RT token's age is advisory, not a gate (#216)", () => {
  it("hands back a 56-minute-old token instead of refusing it — the reported lockout", () => {
    writeToken({ harvestedAt: Date.now() - 56 * MIN });
    const cred = rt.__readRtCredentialForTest(CAMPAIGN);
    expect(cred.customToken).toContain("fake-custom-token");
    expect(cred.databaseURL).toBe("https://roll20-9997.firebaseio.com/");
  });

  it("hands back a long-expired token too — Firebase, not a local clock, refuses it", () => {
    writeToken({ harvestedAt: Date.now() - 6 * 60 * MIN });
    expect(rt.__readRtCredentialForTest(CAMPAIGN).customToken).toContain("fake-custom-token");
  });

  it("still fails loudly when the file is absent", () => {
    expect(() => rt.__readRtCredentialForTest(CAMPAIGN)).toThrow(/nothing has harvested one/);
  });

  it("still fails loudly when the token belongs to another campaign", () => {
    writeToken({ campaignId: "21660022" });
    expect(() => rt.__readRtCredentialForTest(CAMPAIGN)).toThrow(/campaign-scoped/);
  });

  it("still fails loudly on a pre-shard-fix entry with no databaseURL", () => {
    writeToken({ databaseURL: "" });
    expect(() => rt.__readRtCredentialForTest(CAMPAIGN)).toThrow(/no databaseURL/);
  });

  it("still fails loudly when the file carries no customToken", () => {
    writeToken({ customToken: "" });
    expect(() => rt.__readRtCredentialForTest(CAMPAIGN)).toThrow(/no customToken/);
  });
});

describe("transport_status can see the staleness the gem cannot (#216)", () => {
  it("reports a fresh token as present and not stale, with nothing to say", () => {
    writeToken({ harvestedAt: Date.now() - 5 * MIN });
    const s = rt.getRtTokenStatus();
    expect(s).toMatchObject({ present: true, campaignId: CAMPAIGN, stale: false, ageMinutes: 5 });
    expect(s.note).toBeUndefined();
  });

  it("flags a 56-minute-old token as stale and names the other readers it locks out", () => {
    writeToken({ harvestedAt: Date.now() - 56 * MIN });
    const s = rt.getRtTokenStatus();
    expect(s.present).toBe(true);
    expect(s.stale).toBe(true);
    expect(s.ageMinutes).toBe(56);
    expect(s.note).toMatch(/roll20-dm-maps/);
    expect(s.note).toMatch(/[Rr]econnect Roll20/);
  });

  it("flags a missing token file rather than reporting it as fine", () => {
    const s = rt.getRtTokenStatus();
    expect(s).toMatchObject({ present: false, campaignId: null, ageMinutes: null, stale: true });
    expect(s.note).toMatch(/roll20-rt-token\.json/);
  });
});
