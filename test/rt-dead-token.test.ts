// Regression for #186: with an unusable RT credential, a read served from in-memory state must
// FAIL like every other read instead of returning a confident empty answer.
//
// The bug was that get_recent_chat answered straight off the chat buffer without ever touching
// the socket, so at the moment list_tokens was erroring "No usable Roll20 realtime token", the
// same server told a caller the table had said nothing. An agent reading Beyond20 roll cards
// can't tell that from a quiet table, and proceeds on an invented number.
//
// Nothing here is mocked: pointing ROLL20_DATA_DIR at an empty scratch dir means there is no
// roll20-rt-token.json to read, so getCustomToken() throws Roll20TokenUnavailableError on the
// real path, exactly as it does on an expired one. getActiveCampaign()'s env fallback supplies
// the campaign, so no registry files are touched either.
//
// TOKEN_CACHE is resolved at module load, so roll20-rt must be imported AFTER the env is set —
// hence the dynamic import.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

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
let rt: typeof import("../src/bridge/roll20-rt.js");

// The message getCustomToken() raises when it has no usable credential to read.
const DEAD_TOKEN = /No usable Roll20 realtime token/;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rt-dead-token-"));
  process.env.ROLL20_DATA_DIR = tmp;
  process.env.ROLL20_CAMPAIGN_ID = "21660022";
  process.env.DDB_CAMPAIGN_ID = "5201061";
  rt = await import("../src/bridge/roll20-rt.js");
});

afterAll(() => {
  restore("dataDir", "ROLL20_DATA_DIR");
  restore("roll20", "ROLL20_CAMPAIGN_ID");
  restore("ddb", "DDB_CAMPAIGN_ID");
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("a dead RT credential fails every read the same way (#186)", () => {
  it("getRecentChat errors instead of serving [] off the chat buffer", async () => {
    await expect(rt.rtRelayCommand({ action: "getRecentChat", limit: 50 })).rejects.toThrow(DEAD_TOKEN);
  });

  it("getCustomStates errors instead of serving [] off the in-memory store", async () => {
    await expect(rt.rtRelayCommand({ action: "getCustomStates" })).rejects.toThrow(DEAD_TOKEN);
  });

  it("agrees with a socket-touching read — the disagreement WAS the bug", async () => {
    // getTokens always errored correctly; the point is that the in-memory reads now match it,
    // so a client gets one story about whether the server is connected.
    await expect(rt.rtRelayCommand({ action: "getTokens" })).rejects.toThrow(DEAD_TOKEN);
  });
});
