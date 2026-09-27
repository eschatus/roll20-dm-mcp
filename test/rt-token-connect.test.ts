// connect()'s rejection split (#216): with the local age gate gone, Firebase's answer is the only
// signal, so the catch around signInWithCustomToken must tell an AUTH rejection (the token is
// spent/invalid — re-harvest) from everything else (network, quota — the token may be fine).
//
// - auth-shaped code  → typed Roll20TokenUnavailableError naming the code AND the token's age,
//                       pointing the DM at the gem's Connect Roll20.
// - anything else     → rethrown raw. Wrapping a network failure in "rejected the cached token"
//                       would send the DM to re-harvest a credential that was never the problem.
//
// firebase/auth is mocked so no network is touched; the real firebase/app initialises locally.
// TOKEN_CACHE is resolved at module load, so roll20-rt must be imported AFTER the env is set.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const signInWithCustomToken = vi.fn();
vi.mock("firebase/auth", () => ({
  getAuth: () => ({}),
  signInWithCustomToken: (...args: unknown[]) => signInWithCustomToken(...args),
}));

const CAMPAIGN = "17883987";
const MIN = 60_000;

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

function firebaseError(code: string): Error {
  return Object.assign(new Error(`Firebase: Error (${code}).`), { code });
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rt-token-connect-"));
  process.env.ROLL20_DATA_DIR = tmp;
  process.env.ROLL20_CAMPAIGN_ID = CAMPAIGN;
  process.env.DDB_CAMPAIGN_ID = "5201061";
  delete process.env.ROLL20_RT_TOKEN;
  fs.writeFileSync(path.join(tmp, "roll20-rt-token.json"), JSON.stringify({
    campaignId: CAMPAIGN,
    customToken: "eyJhbGciOiJSUzI1NiJ9.fake-custom-token",
    databaseURL: "https://roll20-9997.firebaseio.com/",
    harvestedAt: Date.now() - 56 * MIN,
  }));
  rt = await import("../src/bridge/roll20-rt.js");
});

afterAll(() => {
  restore("dataDir", "ROLL20_DATA_DIR");
  restore("roll20", "ROLL20_CAMPAIGN_ID");
  restore("ddb", "DDB_CAMPAIGN_ID");
  restore("rtToken", "ROLL20_RT_TOKEN");
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => { signInWithCustomToken.mockReset(); delete process.env.ROLL20_RT_TOKEN; });

describe("connect() — Firebase decides, and its reason reaches the DM (#216)", () => {
  it.each(["auth/invalid-custom-token", "auth/invalid-credential", "auth/user-token-expired"])(
    "an auth rejection (%s) becomes the typed error naming the code and the age",
    async (code) => {
      signInWithCustomToken.mockRejectedValueOnce(firebaseError(code));
      const err = await rt.__connectForTest().then(() => null, (e: unknown) => e);
      expect(signInWithCustomToken).toHaveBeenCalledTimes(1);
      expect(signInWithCustomToken.mock.calls[0][1]).toContain("fake-custom-token");
      expect(err).toBeInstanceOf(rt.Roll20TokenUnavailableError);
      const msg = (err as Error).message;
      expect(msg).toContain(`Firebase rejected the cached token (${code})`);
      expect(msg).toMatch(/harvested 56m ago/);
      expect(msg).toMatch(/reconnect Roll20 in the gem/);
    },
  );

  it("a network failure is rethrown raw, NOT dressed up as a rejected token", async () => {
    const netErr = firebaseError("auth/network-request-failed");
    signInWithCustomToken.mockRejectedValueOnce(netErr);
    const err = await rt.__connectForTest().then(() => null, (e: unknown) => e);
    expect(signInWithCustomToken).toHaveBeenCalledTimes(1);
    expect(err).toBe(netErr);
    expect(err).not.toBeInstanceOf(rt.Roll20TokenUnavailableError);
    expect((err as Error).message).not.toMatch(/rejected the cached token/);
  });

  it("an error with no code at all is rethrown raw too", async () => {
    const boom = new Error("socket hang up");
    signInWithCustomToken.mockRejectedValueOnce(boom);
    const err = await rt.__connectForTest().then(() => null, (e: unknown) => e);
    expect(err).toBe(boom);
  });

  it("a rejection of an ROLL20_RT_TOKEN-furnished token names the env source and its remedy", async () => {
    // No harvestedAt: an unknown age is reported as unknown, never invented.
    process.env.ROLL20_RT_TOKEN = JSON.stringify({
      campaignId: CAMPAIGN,
      customToken: "eyJhbGciOiJSUzI1NiJ9.env-custom-token",
      databaseURL: "https://roll20-9997.firebaseio.com/",
    });
    signInWithCustomToken.mockRejectedValueOnce(firebaseError("auth/invalid-custom-token"));
    const err = await rt.__connectForTest().then(() => null, (e: unknown) => e);
    expect(signInWithCustomToken.mock.calls[0][1]).toContain("env-custom-token");
    expect(err).toBeInstanceOf(rt.Roll20TokenUnavailableError);
    expect((err as InstanceType<typeof rt.Roll20TokenUnavailableError>).source).toBe("env");
    const msg = (err as Error).message;
    expect(msg).toMatch(/^No usable Roll20 realtime token/i);
    expect(msg).toContain("from ROLL20_RT_TOKEN: Firebase rejected the cached token (auth/invalid-custom-token); its age is unknown");
    expect(msg).toMatch(/update ROLL20_RT_TOKEN/);
    expect(msg).not.toMatch(/reconnect Roll20 in the gem to re-harvest/);
  });
});
