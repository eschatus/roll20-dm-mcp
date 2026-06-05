// Find where handout gmnotes/notes live in the RTDB tree (for the off-chat relay bus) and whether
// we can read/write them directly. Read-only probe; writes a sample to gitignored .tmp-test-data.
import { writeFileSync, mkdirSync } from "fs";
import path from "path";
import { rtGet } from "../bridge/roll20-rt.js";

function keys(v: unknown): string[] { return v && typeof v === "object" ? Object.keys(v as Record<string, unknown>) : []; }

async function main() {
  const out: Record<string, unknown> = {};
  const handouts = await rtGet<Record<string, Record<string, unknown>>>("handouts");
  const ids = keys(handouts);
  out.count = ids.length;
  console.error(`handouts: ${ids.length}`);
  const first = ids[0];
  if (first) {
    out.listEntryFields = keys(handouts[first]);
    console.error(`list-entry fields: ${JSON.stringify(keys(handouts[first]))}`);
    console.error(`list-entry sample: ${JSON.stringify(handouts[first]).slice(0, 240)}`);
    // Probe candidate blob locations for notes/gmnotes.
    for (const p of [`handout-blobs/${first}`, `handouts/${first}/notes`, `handouts/${first}/gmnotes`]) {
      const v = await rtGet<unknown>(p).catch((e) => `<err ${(e as Error).message.slice(0, 40)}>`);
      const desc = typeof v === "string" ? v.slice(0, 80) : (v && typeof v === "object" ? `obj keys=${JSON.stringify(keys(v))}` : JSON.stringify(v));
      out[p] = desc;
      console.error(`  ${p.replace(first, "<id>")}: ${desc}`);
    }
  }
  // Is there an existing AI-Relay bus handout already?
  const bus = Object.entries(handouts).find(([, h]) => String(h.name || "").toLowerCase().includes("ai-relay"));
  console.error(`\nexisting AI-Relay bus handout: ${bus ? bus[0] + " (" + bus[1].name + ")" : "none"}`);

  const dumpDir = path.resolve("./.tmp-test-data");
  mkdirSync(dumpDir, { recursive: true });
  writeFileSync(path.join(dumpDir, `handout-probe-${Date.now()}.json`), JSON.stringify(out, null, 2), "utf-8");
}
main().then(() => process.exit(0), (e) => { console.error("FAILED:", e); process.exit(1); });
