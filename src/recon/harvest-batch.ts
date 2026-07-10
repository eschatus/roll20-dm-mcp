// Harvest several campaigns sequentially in ONE process (no per-campaign child spawning), so
// stopping it kills cleanly with no orphaned tsx/browser processes. Run with tsx:
//   ROLL20_DATA_DIR=<main>/data tsx src/recon/harvest-batch.ts <slug1> <slug2> ...
process.env.ROLL20_TRANSPORT ??= "rt";
import { harvest } from "./harvest-walls.js";

const slugs = process.argv.slice(2).filter(s => !s.startsWith("--"));
const summary: { slug: string; emitted: number | string }[] = [];
for (const slug of slugs) {
  console.error(`\n##### HARVEST ${slug} #####`);
  try {
    const n = await harvest({ campaign: slug, capture: true });
    summary.push({ slug, emitted: n });
  } catch (e) {
    console.error(`##### ${slug} FAILED: ${String(e).slice(0, 160)}`);
    summary.push({ slug, emitted: "ERROR" });
  }
}
console.error("\n##### BATCH COMPLETE #####");
for (const s of summary) console.error(`  ${s.slug}: ${s.emitted}`);
process.exit(0);
