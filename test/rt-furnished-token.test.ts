// #177: the RT credential is FURNISHED, never minted here. These pin the read side of that
// contract — the source precedence, and that a set-but-unusable ROLL20_RT_TOKEN fails loudly
// instead of quietly falling through to whatever the data dir happens to hold.
//
// Nothing is mocked and nothing reaches the network: every case here is rejected by
// getCustomToken() before the Firebase exchange, so the real code path runs. The env var is read
// per call (not at import), so each case just sets it and drives a relay read.
//
// TOKEN_CACHE is resolved at module load, so roll20-rt must be imported AFTER ROLL20_DATA_DIR is
// set — hence the dynamic import, same as test/rt-dead-token.test.ts.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Deliberately NOT asserted here: what the age of a furnished token does to the gate. That gate is
// being reworked in #216 (Firebase decides whether a token is spent, not a local clock), and a
// case that passes the age check reaches the real Firebase exchange — a network call a unit test
// must not make. Every case below is refused before the exchange.
const CAMPAIGN = "21660022";

const saved = {
  dataDir: process.env.ROLL20_DATA_DIR,
  roll20: process.env.ROLL20_CAMPAIGN_ID,
  ddb: process.env.DDB_CAMPAIGN_ID,
  rtToken: process.env.ROLL20_RT_TOKEN,
};
const restore = (key: keyof typeof saved, name: string) => {
  if (saved[key] === undefined) delete process.env[name];
  else process.env[name] = saved[key];
};

let tmp: string;
let rt: typeof import("../src/bridge/roll20-rt.js");

// Any read goes through getConn() → getCustomToken(), so one action exercises the whole gate.
const read = () => rt.rtRelayCommand({ action: "getTokens" });

const token = (over: Record<string, unknown> = {}) => JSON.stringify({
  campaignId: CAMPAIGN,
  customToken: "furnished-not-minted",
  databaseURL: "https://roll20-99910.firebaseio.com/",
  harvestedAt: Date.now(),
  ...over,
});

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rt-furnished-"));
  process.env.ROLL20_DATA_DIR = tmp;
  process.env.ROLL20_CAMPAIGN_ID = CAMPAIGN;
  process.env.DDB_CAMPAIGN_ID = "5201061";
  delete process.env.ROLL20_RT_TOKEN;
  rt = await import("../src/bridge/roll20-rt.js");
});

afterEach(() => {
  delete process.env.ROLL20_RT_TOKEN;
  fs.rmSync(path.join(tmp, "roll20-rt-token.json"), { force: true });
});

afterAll(() => {
  restore("dataDir", "ROLL20_DATA_DIR");
  restore("roll20", "ROLL20_CAMPAIGN_ID");
  restore("ddb", "DDB_CAMPAIGN_ID");
  restore("rtToken", "ROLL20_RT_TOKEN");
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("the RT token is read from ROLL20_RT_TOKEN or the data dir, never harvested (#177)", () => {
  it("falls back to the data dir when the env var is unset, and says nothing harvested one", async () => {
    await expect(read()).rejects.toThrow(/no token file — nothing has harvested one/);
  });

  it("reads the env var: a wrong-campaign token is refused BY CAMPAIGN, proving it was parsed", async () => {
    process.env.ROLL20_RT_TOKEN = token({ campaignId: "999999" });
    await expect(read()).rejects.toThrow(/belongs to campaign 999999/);
  });

  it("takes precedence over the file — an explicitly furnished credential wins", async () => {
    fs.writeFileSync(path.join(tmp, "roll20-rt-token.json"), token({ campaignId: "111111" }));
    process.env.ROLL20_RT_TOKEN = token({ campaignId: "222222" });
    await expect(read()).rejects.toThrow(/belongs to campaign 222222/);
  });

  it("fails loudly on malformed JSON instead of falling through to the file", async () => {
    fs.writeFileSync(path.join(tmp, "roll20-rt-token.json"), token({ campaignId: "111111" }));
    process.env.ROLL20_RT_TOKEN = "{not json";
    await expect(read()).rejects.toThrow(/ROLL20_RT_TOKEN is set but is not valid JSON/);
  });

  it("fails loudly on a JSON non-object", async () => {
    process.env.ROLL20_RT_TOKEN = '"just-the-token-string"';
    await expect(read()).rejects.toThrow(/ROLL20_RT_TOKEN is set but is not a JSON object/);
  });

  it("names the missing fields rather than reconnecting to the wrong shard", async () => {
    process.env.ROLL20_RT_TOKEN = JSON.stringify({ campaignId: CAMPAIGN, customToken: "x" });
    await expect(read()).rejects.toThrow(/is missing databaseURL/);
  });
});
