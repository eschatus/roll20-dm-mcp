// set_journal_folder must tell the truth about whether the write LANDED.
//
// Regression for the masking bug: the tool used to return a hardcoded
// "journal folder tree updated" and discard the relay result — so a campaign
// whose sandbox silently no-ops Campaign().set("_journalfolder", …) (the value
// never persists, returns ok anyway) looked clean while 62 objects sat unfiled
// at the journal root. The fix reads the tree back and verifies it changed.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { setupHarness, type Harness } from "./harness.js";
import { registerJournalTools } from "../src/tools/journal.js";

let h: Harness;
beforeEach(() => {
  h = setupHarness({ seed: 11 });
  registerJournalTools(h.server as never); // harness doesn't register journal tools by default
});
afterEach(() => h.teardown());

describe("set_journal_folder — honest read-back", () => {
  it("replace: verifies the write by reading the tree back", async () => {
    const tree = [{ n: "Folder A", i: [] }, "id-1", "id-2"];
    const { text } = await h.callTool("set_journal_folder", { json: tree });
    expect(text).toMatch(/verified by read-back/);
    expect(text).toContain("3 top-level");
    expect(JSON.parse(h.emu.campaignModel.get("_journalfolder") as string)).toHaveLength(3);
  });

  it("append: reports the appended count and verified total", async () => {
    h.emu.campaignModel.set("_journalfolder", JSON.stringify(["existing-id"]));
    const { text } = await h.callTool("set_journal_folder", {
      json: { __append__: [{ n: "DDEP-DRW01 — Assault on Myth Nantar", i: [] }] },
    });
    expect(text).toMatch(/verified by read-back/);
    expect(text).toMatch(/appended 1/);
    expect(text).toContain("2 top-level");
  });

  it("reports FAILURE when the set does not persist (the real bug)", async () => {
    // Simulate the sandbox that returns ok but never lands: no-op the _journalfolder set.
    const orig = h.emu.campaignModel.set.bind(h.emu.campaignModel);
    h.emu.campaignModel.set = ((k: string, v: unknown) => {
      if (k === "_journalfolder") return h.emu.campaignModel; // swallow — value never lands
      return orig(k, v);
    }) as typeof h.emu.campaignModel.set;

    const entry = h.server.handlers.get("set_journal_folder")!;
    const res = await entry.handler({ json: [{ n: "A", i: [] }, "x", "y"] });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/did NOT persist/);
    expect(res.content[0].text).toMatch(/read back 0/);
  });
});
