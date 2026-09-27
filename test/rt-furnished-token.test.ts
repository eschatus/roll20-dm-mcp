// #177: the RT credential is FURNISHED, never minted here. These pin the read side of that
// contract — the source precedence, and that a set-but-unusable ROLL20_RT_TOKEN fails loudly
// instead of quietly falling through to whatever the data dir happens to hold.
//
// Nothing is mocked and nothing reaches the network. The cases that drive a relay read are all
// rejected by getCustomToken() BEFORE the Firebase exchange, so the real code path runs; the cases
// about a token that WOULD be offered to Firebase go through the pre-flight seam
// (__readRtCredentialForTest) and getRtTokenStatus instead, neither of which touches the network.
// The env var is read per call (not at import), so each case just sets it.
//
// TOKEN_CACHE is resolved at module load, so roll20-rt must be imported AFTER ROLL20_DATA_DIR is
// set — hence the dynamic import, same as test/rt-dead-token.test.ts.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Age is advisory, not a gate (#216): Firebase decides whether a token is spent, in connect().
// So a structurally sound token is never refused here — driving one through a relay read would
// reach the real Firebase exchange, which a unit test must not do. Those cases use the seam.
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

// The typed error itself, straight off the pre-flight read (the relay path above wraps it in an
// RtPreSendError, so its message carries a transport prefix and the typed fields are not reachable).
type TokenErr = InstanceType<typeof rt.Roll20TokenUnavailableError>;
const refusal = (): TokenErr | null => {
  try { rt.__readRtCredentialForTest(CAMPAIGN); return null; }
  catch (e) { return e as TokenErr; }
};

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
  it("falls back to the data dir when the env var is unset, and says it checked both", async () => {
    await expect(read()).rejects.toThrow(/No usable Roll20 realtime token/);
    const err = refusal();
    expect(err).toBeInstanceOf(rt.Roll20TokenUnavailableError);
    // dm-whisper matches this prefix — it must survive any rewording of the rest.
    expect(err!.message).toMatch(/^No usable Roll20 realtime token/i);
    expect(err!.message).toMatch(/checked ROLL20_RT_TOKEN and .*roll20-rt-token\.json/);
    expect(err!.message).toMatch(/ROLL20_RT_TOKEN is unset and there is no token file — nothing has harvested one/);
    expect(err!.source).toBeNull();
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

  it("refuses a set-but-blank env var rather than quietly using the file", async () => {
    fs.writeFileSync(path.join(tmp, "roll20-rt-token.json"), token({ campaignId: "111111" }));
    process.env.ROLL20_RT_TOKEN = "   ";
    await expect(read()).rejects.toThrow(/ROLL20_RT_TOKEN is set but is empty/);
  });

  it("keeps an explicit harvestedAt of 0 as-is (unknown age) instead of repairing it to 'now'", () => {
    process.env.ROLL20_RT_TOKEN = token({ harvestedAt: 0 });
    const cred = rt.__readRtCredentialForTest(CAMPAIGN);
    expect(cred).toMatchObject({ harvestedAt: 0, source: "env" });
    expect(rt.getRtTokenStatus(CAMPAIGN)).toMatchObject({
      present: true, source: "env", ageMinutes: null, stale: true,
    });
  });

  it("records a missing harvestedAt as 0 (unknown age), not an invented stamp", () => {
    const { harvestedAt: _omit, ...rest } = JSON.parse(token()) as Record<string, unknown>;
    process.env.ROLL20_RT_TOKEN = JSON.stringify(rest);
    expect(rt.__readRtCredentialForTest(CAMPAIGN).harvestedAt).toBe(0);
    const s = rt.getRtTokenStatus(CAMPAIGN);
    expect(s).toMatchObject({ ageMinutes: null, stale: true });
    expect(s.note).toContain("of unknown age");
  });

  it("passes a stamped env token through with its stamp, and the status names the env source", () => {
    const at = Date.now() - 5 * 60_000;
    process.env.ROLL20_RT_TOKEN = token({ harvestedAt: at });
    expect(rt.__readRtCredentialForTest(CAMPAIGN)).toMatchObject({ harvestedAt: at, source: "env" });
    expect(rt.getRtTokenStatus(CAMPAIGN)).toMatchObject({ present: true, source: "env", ageMinutes: 5, stale: false });
  });

  it("refuses a non-numeric harvestedAt", async () => {
    process.env.ROLL20_RT_TOKEN = token({ harvestedAt: "yesterday" });
    await expect(read()).rejects.toThrow(/harvestedAt is not a finite epoch-ms number/);
  });
});

describe("every refusal names its source, and the remedy fits it", () => {
  it("an env-sourced refusal says to update/unset ROLL20_RT_TOKEN, not to reconnect in the gem", async () => {
    process.env.ROLL20_RT_TOKEN = token({ campaignId: "999999" });
    const err = refusal();
    expect(err).toBeInstanceOf(rt.Roll20TokenUnavailableError);
    const msg = err!.message;
    expect(msg).toMatch(/^No usable Roll20 realtime token/i);
    expect(msg).toMatch(/from ROLL20_RT_TOKEN: the token belongs to campaign 999999/);
    expect(msg).toMatch(/update ROLL20_RT_TOKEN/);
    expect(msg).toMatch(/or unset it/);
    // The gem's re-harvest rewrites the FILE, which this variable overrides — so that remedy is
    // wrong here, and the message must say so rather than prescribe it.
    expect(msg).not.toMatch(/reconnect Roll20 in the gem to re-harvest/);
    expect(msg).toMatch(/will not help while it is set/);
    expect(err!.source).toBe("env");
  });

  it("a malformed env var is env-sourced too", async () => {
    process.env.ROLL20_RT_TOKEN = "{not json";
    const err = refusal();
    expect(err!.source).toBe("env");
    expect(err!.message).toMatch(/update ROLL20_RT_TOKEN/);
  });

  it("a file-sourced refusal names the file and keeps the reconnect-in-the-gem remedy", async () => {
    fs.writeFileSync(path.join(tmp, "roll20-rt-token.json"), token({ campaignId: "111111" }));
    const err = refusal();
    const msg = err!.message;
    expect(msg).toMatch(/^No usable Roll20 realtime token/i);
    expect(msg).toMatch(/from .*roll20-rt-token\.json: the token belongs to campaign 111111/);
    expect(msg).toMatch(/reconnect Roll20 in the gem/);
    expect(err!.source).toBe("file");
  });
});

describe("getRtTokenStatus reports a broken ROLL20_RT_TOKEN instead of throwing", () => {
  it.each([
    ["malformed JSON", "{not json", /not valid JSON/],
    ["blank", "   ", /is empty/],
    ["missing fields", JSON.stringify({ campaignId: CAMPAIGN }), /is missing customToken\/databaseURL/],
    ["non-finite stamp", token({ harvestedAt: "yesterday" }), /not a finite epoch-ms number/],
  ])("%s → present:false, source:env, the reason in the note", (_label, value, reason) => {
    process.env.ROLL20_RT_TOKEN = value;
    const s = rt.getRtTokenStatus(CAMPAIGN);
    expect(s).toMatchObject({ present: false, source: "env", ageMinutes: null, stale: true });
    expect(s.note).toMatch(reason);
    expect(s.note).toMatch(/^No usable Roll20 realtime token/i);
  });

  it("with neither source, says both were checked", () => {
    const s = rt.getRtTokenStatus(CAMPAIGN);
    expect(s).toMatchObject({ present: false, source: null });
    expect(s.note).toMatch(/ROLL20_RT_TOKEN is unset and there is no roll20-rt-token\.json/);
  });

  it("names the file source for a file token", () => {
    fs.writeFileSync(path.join(tmp, "roll20-rt-token.json"), token());
    expect(rt.getRtTokenStatus(CAMPAIGN)).toMatchObject({ present: true, source: "file", stale: false });
  });
});
