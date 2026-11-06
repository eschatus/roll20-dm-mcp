// #279: one stored token per campaign. Furnishing a second game used to overwrite the first, and the
// next connect for the first game was refused even though its refresh token was still good.
//
// roll20-rt-token.json stays live, because the gem writes every harvest there, so these also pin how
// the old file feeds the slots. Everything runs against a scratch data dir with firebase/auth mocked:
// no Roll20, no network, and fake tokens only.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const restoreRefreshUser = vi.fn();
const signInWithCustomToken = vi.fn();
vi.mock("../src/bridge/rt-refresh-auth.js", () => ({ restoreRefreshUser: (...a: unknown[]) => restoreRefreshUser(...a) }));
vi.mock("firebase/auth", () => ({
  getAuth: () => ({}),
  signInWithCustomToken: (...a: unknown[]) => signInWithCustomToken(...a),
}));

const A = "17491327";
const B = "21660022";
const DB = "https://roll20-99926.firebaseio.com";
const MIN = 60_000;

const saved = { dir: process.env.ROLL20_DATA_DIR, id: process.env.ROLL20_CAMPAIGN_ID, env: process.env.ROLL20_RT_TOKEN };
const put = (name: string, v: string | undefined) => { if (v === undefined) delete process.env[name]; else process.env[name] = v; };

let tmp: string;
let rt: typeof import("../src/bridge/roll20-rt.js");
let store: typeof import("../src/bridge/rt-token-store.js");

const legacyFile = () => path.join(tmp, "roll20-rt-token.json");
const slotFile = (id: string) => path.join(tmp, "rt-tokens", `${id}.json`);
const slot = (id: string) => JSON.parse(fs.readFileSync(slotFile(id), "utf-8")) as Record<string, unknown>;
const record = (campaignId: string, over: Record<string, unknown> = {}) => ({
  campaignId, refreshToken: `refresh-${campaignId}`, databaseURL: DB, harvestedAt: Date.now() - 10 * MIN, ...over,
});
const furnish = (campaignId: string, over: Record<string, unknown> = {}) =>
  store.writeRtTokenSlot(record(campaignId, over) as Parameters<typeof store.writeRtTokenSlot>[0]);
/** What the gem does on every harvest: overwrite the one old file. */
const gemHarvest = (campaignId: string, over: Record<string, unknown> = {}) =>
  fs.writeFileSync(legacyFile(), JSON.stringify({
    campaignId, customToken: `custom-${campaignId}`, databaseURL: DB, harvestedAt: Date.now(), ...over,
  }));
const firebaseError = (code: string) => Object.assign(new Error(code), { code });

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rt-slots-"));
  process.env.ROLL20_DATA_DIR = tmp;
  process.env.ROLL20_CAMPAIGN_ID = A;
  delete process.env.ROLL20_RT_TOKEN;
  rt = await import("../src/bridge/roll20-rt.js");
  store = await import("../src/bridge/rt-token-store.js");
});

afterAll(() => {
  put("ROLL20_DATA_DIR", saved.dir);
  put("ROLL20_CAMPAIGN_ID", saved.id);
  put("ROLL20_RT_TOKEN", saved.env);
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  restoreRefreshUser.mockReset();
  signInWithCustomToken.mockReset();
  delete process.env.ROLL20_RT_TOKEN;
  process.env.ROLL20_CAMPAIGN_ID = A;
  fs.rmSync(legacyFile(), { force: true, recursive: true });
  fs.rmSync(path.join(tmp, "rt-tokens"), { recursive: true, force: true });
});

afterEach(() => vi.restoreAllMocks());

describe("each campaign keeps its own token", () => {
  it("furnishing one campaign leaves another's slot byte-identical", () => {
    furnish(A);
    const before = fs.readFileSync(slotFile(A), "utf-8");
    furnish(B);
    expect(fs.readFileSync(slotFile(A), "utf-8")).toBe(before);
    expect(rt.__readRtCredentialForTest(A).refreshToken).toBe(`refresh-${A}`);
    expect(rt.__readRtCredentialForTest(B).refreshToken).toBe(`refresh-${B}`);
  });

  it("the reported lockout: the old file moving to another game no longer refuses the first", () => {
    gemHarvest(A, { refreshToken: `refresh-${A}`, customToken: undefined });
    expect(rt.__readRtCredentialForTest(A).refreshToken).toBe(`refresh-${A}`);
    gemHarvest(B);
    expect(rt.__readRtCredentialForTest(A).refreshToken).toBe(`refresh-${A}`);
    expect(rt.__readRtCredentialForTest(B).customToken).toBe(`custom-${B}`);
  });

  it("the connect path signs in with the token of the campaign being connected", async () => {
    furnish(A, { refreshToken: undefined, customToken: `custom-${A}` });
    furnish(B, { refreshToken: undefined, customToken: `custom-${B}` });
    signInWithCustomToken.mockRejectedValue(firebaseError("auth/network-request-failed"));
    await expect(rt.__connectForTest()).rejects.toThrow("network-request-failed");
    process.env.ROLL20_CAMPAIGN_ID = B;
    await expect(rt.__connectForTest()).rejects.toThrow("network-request-failed");
    expect(signInWithCustomToken.mock.calls.map((c) => c[1])).toEqual([`custom-${A}`, `custom-${B}`]);
  });

  it("writes the slot owner-only and leaves no temp file behind", () => {
    furnish(A);
    expect(fs.readdirSync(path.join(tmp, "rt-tokens"))).toEqual([`${A}.json`]);
    if (process.platform !== "win32") expect(fs.statSync(slotFile(A)).mode & 0o777).toBe(0o600);
  });
});

describe("a missing token is loud and never borrows another campaign's", () => {
  it("names the campaign, with another campaign's token on hand in a slot and the old file", () => {
    furnish(B);
    gemHarvest(B);
    let err: InstanceType<typeof rt.Roll20TokenUnavailableError> | undefined;
    try { rt.__readRtCredentialForTest(A); } catch (e) { err = e as typeof err; }
    expect(err).toBeInstanceOf(rt.Roll20TokenUnavailableError);
    expect(err!.campaignId).toBe(A);
    // dm-whisper's refusedRtCampaign reads the campaign id out of exactly this opening.
    expect(err!.message).toMatch(new RegExp(`^No usable Roll20 realtime token for campaign ${A} `));
    expect(err!.message).toMatch(/a token for another campaign is never used/);
  });

  it("refuses a campaign id that is not an id, and files nothing outside the store", () => {
    const escaped = `escaped-${path.basename(tmp)}`; // Unique, so a stale file can't fail this.
    gemHarvest(`../../${escaped}`);
    expect(() => rt.__readRtCredentialForTest(`../../${escaped}`)).toThrow(/not numeric/);
    expect(fs.existsSync(path.join(tmp, "..", `${escaped}.json`))).toBe(false);
    expect(fs.existsSync(path.join(tmp, "rt-tokens"))).toBe(false);
  });
});

describe("the old single file stays a live inbox", () => {
  it("is filed under the campaign it holds, even when another campaign is being read", () => {
    gemHarvest(B);
    expect(() => rt.__readRtCredentialForTest(A)).toThrow(/No usable Roll20 realtime token/);
    expect(slot(B)).toMatchObject({ campaignId: B, customToken: `custom-${B}` });
  });

  it("is copied, not moved: the gem's keeper force-harvests when the file is missing", () => {
    gemHarvest(A);
    const before = fs.readFileSync(legacyFile(), "utf-8");
    rt.__readRtCredentialForTest(A);
    expect(fs.readFileSync(legacyFile(), "utf-8")).toBe(before);
  });

  it("a later harvest for the same campaign replaces the earlier custom token", () => {
    gemHarvest(A, { harvestedAt: Date.now() - 45 * MIN });
    rt.__readRtCredentialForTest(A);
    gemHarvest(A, { customToken: "custom-newer" });
    expect(rt.__readRtCredentialForTest(A).customToken).toBe("custom-newer");
  });

  it("an older file does not overwrite a newer slot", () => {
    furnish(A, { refreshToken: undefined, customToken: "custom-slot", harvestedAt: Date.now() });
    gemHarvest(A, { customToken: "custom-old", harvestedAt: Date.now() - 45 * MIN });
    expect(rt.__readRtCredentialForTest(A).customToken).toBe("custom-slot");
  });

  it("a newer custom token never displaces a working refresh token (the 40-minute clobber)", () => {
    furnish(A);
    gemHarvest(A);
    expect(rt.__readRtCredentialForTest(A)).toMatchObject({ refreshToken: `refresh-${A}` });
    expect(slot(A).customToken).toBeUndefined();
  });

  it("a newer refresh token does replace an older one", () => {
    furnish(A);
    gemHarvest(A, { customToken: undefined, refreshToken: "refresh-newer" });
    expect(rt.__readRtCredentialForTest(A).refreshToken).toBe("refresh-newer");
  });

  it("a structurally useless file does not displace a good slot", () => {
    furnish(A);
    gemHarvest(A, { customToken: undefined, databaseURL: "" });
    expect(rt.__readRtCredentialForTest(A).refreshToken).toBe(`refresh-${A}`);
  });
});

describe("the gem can still recover from a dead refresh token", () => {
  const refuseRefreshToken = async () => {
    restoreRefreshUser.mockRejectedValue(firebaseError("auth/invalid-refresh-token"));
    await expect(rt.__connectForTest()).rejects.toThrow(/auth\/invalid-refresh-token/);
  };

  it("a custom token harvested AFTER the refusal takes the slot", async () => {
    furnish(A);
    await refuseRefreshToken();
    gemHarvest(A, { harvestedAt: Date.now() + MIN });
    const cred = rt.__readRtCredentialForTest(A);
    expect(cred.customToken).toBe(`custom-${A}`);
    expect(cred.refreshToken).toBeUndefined();
  });

  it("a custom token harvested BEFORE the refusal does not", async () => {
    furnish(A);
    gemHarvest(A, { harvestedAt: Date.now() - MIN });
    await refuseRefreshToken();
    expect(rt.__readRtCredentialForTest(A).refreshToken).toBe(`refresh-${A}`);
  });

  it("a network failure says nothing about the token, so nothing is recorded", async () => {
    furnish(A);
    restoreRefreshUser.mockRejectedValue(firebaseError("auth/network-request-failed"));
    await expect(rt.__connectForTest()).rejects.toThrow("network-request-failed");
    expect(slot(A).refusedAt).toBeUndefined();
  });

  it("a refusal never lands on a slot that has been re-furnished since", () => {
    furnish(A, { refreshToken: "refresh-replacement" });
    store.markRtTokenRefused(A, `refresh-${A}`, Date.now());
    expect(slot(A).refusedAt).toBeUndefined();
  });

  it("an env-furnished token leaves the data dir out of it", async () => {
    furnish(A);
    // The same token in both places, so only the source can keep the slot out of it.
    process.env.ROLL20_RT_TOKEN = JSON.stringify(record(A));
    await refuseRefreshToken();
    expect(slot(A).refusedAt).toBeUndefined();
  });

  it("if the refusal cannot be recorded, the Firebase rejection is still what reaches the caller", async () => {
    furnish(A);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    // Corrupting the slot between read and record is the one failure reachable without a mock of fs.
    restoreRefreshUser.mockImplementation(async () => {
      fs.writeFileSync(slotFile(A), "{broken");
      throw firebaseError("auth/invalid-refresh-token");
    });
    await expect(rt.__connectForTest()).rejects.toThrow(/Firebase rejected the cached token \(auth\/invalid-refresh-token\)/);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/could not record the refused token/));
  });
});

describe("failures name the file and leak nothing", () => {
  it("a corrupt old file does not refuse a campaign whose slot is fine, and is reported", () => {
    furnish(A);
    fs.writeFileSync(legacyFile(), '{"refreshToken":"secret-value"');
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(rt.__readRtCredentialForTest(A).refreshToken).toBe(`refresh-${A}`);
    const s = rt.getRtTokenStatus(A);
    expect(s).toMatchObject({ present: true, source: "file" });
    expect(s.note).toMatch(/roll20-rt-token\.json .*not valid JSON/);
    expect(s.note).not.toContain("secret-value");
  });

  it("a corrupt old file is named in the refusal when there is no slot", () => {
    fs.writeFileSync(legacyFile(), '{"refreshToken":"secret-value"');
    vi.spyOn(console, "error").mockImplementation(() => {});
    let msg = "";
    try { rt.__readRtCredentialForTest(A); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/no stored token.*not valid JSON/);
    expect(msg).not.toContain("secret-value");
  });

  it("a corrupt slot is a typed refusal naming the slot, and status reports it instead of throwing", () => {
    fs.mkdirSync(path.join(tmp, "rt-tokens"), { recursive: true });
    fs.writeFileSync(slotFile(A), '{"refreshToken":"secret-value"');
    let err: InstanceType<typeof rt.Roll20TokenUnavailableError> | undefined;
    try { rt.__readRtCredentialForTest(A); } catch (e) { err = e as typeof err; }
    expect(err).toBeInstanceOf(rt.Roll20TokenUnavailableError);
    expect(err!.source).toBe("file");
    expect(err!.message).toMatch(/rt-tokens.17491327\.json is not valid JSON/);
    expect(err!.message).not.toContain("secret-value");
    expect(rt.getRtTokenStatus(A)).toMatchObject({ present: false, source: "file" });
  });

  it("an import that cannot be stored is reported, with the old file left intact", () => {
    gemHarvest(A);
    fs.writeFileSync(path.join(tmp, "rt-tokens"), "a file where the directory should be");
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => rt.__readRtCredentialForTest(A)).toThrow(/could not be filed under its campaign/);
    expect(fs.existsSync(legacyFile())).toBe(true);
  });

  // Linux reports ENOTDIR for a path under a file where Windows reports ENOENT, so the test above
  // only reaches this path on Linux. A corrupt slot reaches it everywhere.
  it("a slot that cannot be read does not hide why the import failed", () => {
    gemHarvest(A);
    fs.mkdirSync(path.join(tmp, "rt-tokens"), { recursive: true });
    fs.writeFileSync(slotFile(A), "{not json");
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => rt.__readRtCredentialForTest(A)).toThrow(/is not valid JSON.*could not be filed under its campaign/);
  });

  it("no error or status text ever carries a token value", () => {
    furnish(B);
    gemHarvest(B);
    const s = JSON.stringify(rt.getRtTokenStatus(A)) + JSON.stringify(rt.getRtTokenStatus(B));
    expect(s).not.toContain(`refresh-${B}`);
    expect(s).not.toContain(`custom-${B}`);
  });
});

describe("ROLL20_RT_TOKEN stays one override that wins", () => {
  it("beats the campaign's slot", () => {
    furnish(A);
    process.env.ROLL20_RT_TOKEN = JSON.stringify(record(A, { refreshToken: "refresh-env" }));
    expect(rt.__readRtCredentialForTest(A)).toMatchObject({ refreshToken: "refresh-env", source: "env" });
  });

  it("set for another campaign refuses, with a good slot right there", () => {
    furnish(A);
    process.env.ROLL20_RT_TOKEN = JSON.stringify(record(B));
    expect(() => rt.__readRtCredentialForTest(A)).toThrow(new RegExp(`from ROLL20_RT_TOKEN: the token belongs to campaign ${B}`));
  });

  it("set but unusable throws, with a good slot right there", () => {
    furnish(A);
    process.env.ROLL20_RT_TOKEN = "{not json";
    expect(() => rt.__readRtCredentialForTest(A)).toThrow(/ROLL20_RT_TOKEN is set but is not valid JSON/);
  });

  it("while set, the data dir is not consulted, so nothing is imported", () => {
    gemHarvest(B);
    process.env.ROLL20_RT_TOKEN = JSON.stringify(record(A));
    rt.__readRtCredentialForTest(A);
    expect(fs.existsSync(slotFile(B))).toBe(false);
  });
});

describe("transport_status answers for the active campaign", () => {
  it("reports that campaign's own token and age", () => {
    furnish(A, { harvestedAt: Date.now() - 7 * MIN });
    furnish(B, { harvestedAt: Date.now() - 90 * MIN });
    expect(rt.getRtTokenStatus(A)).toMatchObject({ present: true, source: "file", campaignId: A, activeCampaignId: A, ageMinutes: 7 });
    expect(rt.getRtTokenStatus(B)).toMatchObject({ present: true, source: "file", campaignId: B, activeCampaignId: B, ageMinutes: 90 });
  });

  it("does not count another campaign's token", () => {
    furnish(B);
    const s = rt.getRtTokenStatus(A);
    expect(s).toMatchObject({ present: false, source: null, campaignId: null, activeCampaignId: A, ageMinutes: null });
    expect(s.note).toContain(A);
  });

  it("sees a token the old file delivered, the same as connect would", () => {
    gemHarvest(A);
    expect(rt.getRtTokenStatus(A)).toMatchObject({ present: true, source: "file", campaignId: A, ageMinutes: 0 });
  });

  it("still files the old file with no campaign active", () => {
    gemHarvest(B);
    rt.getRtTokenStatus(null);
    expect(slot(B).campaignId).toBe(B);
  });
});
