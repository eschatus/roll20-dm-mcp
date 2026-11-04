// A credential may carry a refreshToken in place of the one-shot customToken. Connecting from it was
// proved live on cos-test (2026-11-03); these pin the routing around that seam, offline.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
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

const CAMPAIGN = "21660022";
const DAY = 86_400_000;
const saved = { dir: process.env.ROLL20_DATA_DIR, id: process.env.ROLL20_CAMPAIGN_ID, env: process.env.ROLL20_RT_TOKEN };
const put = (name: string, v: string | undefined) => { if (v === undefined) delete process.env[name]; else process.env[name] = v; };

let tmp: string;
let rt: typeof import("../src/bridge/roll20-rt.js");
const writeFile = (extra: Record<string, unknown>) => fs.writeFileSync(path.join(tmp, "roll20-rt-token.json"), JSON.stringify({
  campaignId: CAMPAIGN, databaseURL: "https://roll20-99926.firebaseio.com", harvestedAt: Date.now() - 30 * DAY, ...extra,
}));

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rt-refresh-"));
  process.env.ROLL20_DATA_DIR = tmp;
  process.env.ROLL20_CAMPAIGN_ID = CAMPAIGN;
  delete process.env.ROLL20_RT_TOKEN;
  rt = await import("../src/bridge/roll20-rt.js");
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
});

describe("reading a refreshToken credential", () => {
  it("accepts a file with no customToken, and doesn't call an old one stale", () => {
    writeFile({ refreshToken: "r" });
    expect(rt.__readRtCredentialForTest(CAMPAIGN).refreshToken).toBe("r");
    expect(rt.getRtTokenStatus(CAMPAIGN)).toMatchObject({ stale: false, missingFields: [] });
  });

  it("accepts the same shape in ROLL20_RT_TOKEN", () => {
    process.env.ROLL20_RT_TOKEN = JSON.stringify({ campaignId: CAMPAIGN, refreshToken: "r", databaseURL: "https://x.firebaseio.com" });
    expect(rt.__readRtCredentialForTest(CAMPAIGN)).toMatchObject({ refreshToken: "r", source: "env" });
  });

  it("still refuses a credential holding neither token", () => {
    writeFile({});
    expect(() => rt.__readRtCredentialForTest(CAMPAIGN)).toThrow(/no customToken or refreshToken/);
    expect(rt.getRtTokenStatus(CAMPAIGN).missingFields).toEqual(["customToken"]);
  });
});

describe("connecting", () => {
  it("prefers the refresh token and never spends the custom token", async () => {
    writeFile({ refreshToken: "r", customToken: "c" });
    restoreRefreshUser.mockRejectedValue(Object.assign(new Error("x"), { code: "auth/network-request-failed" }));
    await expect(rt.__connectForTest()).rejects.toThrow("x");
    expect(restoreRefreshUser).toHaveBeenCalledTimes(1);
    expect(restoreRefreshUser.mock.calls[0][1]).toBe("r");
    expect(signInWithCustomToken).not.toHaveBeenCalled();
  });

  it("refuses a login whose campaign claim isn't the active campaign, whatever the file says", async () => {
    writeFile({ refreshToken: "r" });
    restoreRefreshUser.mockResolvedValue({
      getIdTokenResult: async () => ({ claims: { currentcampaign: "campaign-22125197-abc", playerid: "p", userid: "u" } }),
    });
    await expect(rt.__connectForTest()).rejects.toThrow(/No usable Roll20 realtime token.*campaign-22125197/);
  });

  it("a refused refresh token is the typed credential error, and a network failure is not", async () => {
    writeFile({ refreshToken: "r" });
    restoreRefreshUser.mockRejectedValue(Object.assign(new Error("no"), { code: "auth/invalid-refresh-token" }));
    await expect(rt.__connectForTest()).rejects.toThrow(/No usable Roll20 realtime token.*auth\/invalid-refresh-token/);
    restoreRefreshUser.mockRejectedValue(Object.assign(new Error("offline"), { code: "auth/network-request-failed" }));
    await expect(rt.__connectForTest()).rejects.toThrow(/^offline$/);
  });
});
