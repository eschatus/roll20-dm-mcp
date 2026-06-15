// Regression — getCurrentPageId() must never leak a falsy non-string "page id".
// Roll20 returns boolean false (the emulator returns "") for playerpageid when no
// player page is set; previously that value escaped and silently mis-targeted every
// relay call that defaults to `args.pageId ?? getCurrentPageId()`. It must throw
// an actionable error instead, and return the real id once a player page exists.
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { setupHarness, type Harness } from "./harness.js";
import * as roll20 from "../src/bridge/roll20.js";

let h: Harness | undefined;

beforeEach(() => {
  // Force the browser/evaluate path (not the rt branch) so this exercises the guard.
  delete process.env.ROLL20_TRANSPORT;
});
afterEach(() => h?.teardown());

describe("getCurrentPageId falsy guard", () => {
  it("throws an actionable error when no player page is set", async () => {
    h = setupHarness(); // emulator starts with playerpageid = "" (unset)
    await expect(roll20.getCurrentPageId()).rejects.toThrow(/player page|playerpageid/i);
  });

  it("returns the player page id once one is set", async () => {
    h = setupHarness();
    const pid = h.emu.createPage("Test Page");
    h.emu.setPlayerPage(pid);
    await expect(roll20.getCurrentPageId()).resolves.toBe(pid);
  });
});
