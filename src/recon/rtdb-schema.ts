// Verify the real RTDB shapes via the authenticated socket (get()), using the paths the browser
// actually subscribes to (from the first recon): graphics/page/<id>, paths/page/<id>, campaign, etc.
// Writes samples to gitignored .tmp-test-data; prints structure to stderr.

import { writeFileSync, mkdirSync } from "fs";
import path from "path";
import { rtGet } from "../bridge/roll20-rt.js";

function keys(v: unknown): string[] {
  return v && typeof v === "object" ? Object.keys(v as Record<string, unknown>) : [];
}
function sampleChild(v: unknown): { id?: string; fields?: string[]; value?: unknown } {
  const k = keys(v);
  if (!k.length) return { value: v };
  const first = (v as Record<string, unknown>)[k[0]];
  return { id: k[0], fields: keys(first) };
}

async function main() {
  const out: Record<string, unknown> = {};

  // Campaign node: turnorder, token_markers, playerpageid, etc.
  const campaign = await rtGet<Record<string, unknown>>("campaign");
  out.campaignKeys = keys(campaign);
  console.error("campaign keys:", JSON.stringify(keys(campaign)));
  for (const k of ["turnorder", "playerpageid", "token_markers", "playerspecificpages"]) {
    const v = (campaign as Record<string, unknown>)?.[k];
    console.error(`  campaign.${k}: ${typeof v === "string" ? v.slice(0, 160) : JSON.stringify(v)?.slice(0, 160)}`);
  }
  const playerPage = (campaign as Record<string, unknown>)?.playerpageid as string | undefined;

  // Pages list.
  const pages = await rtGet<Record<string, unknown>>("pages");
  out.pageIds = keys(pages);
  console.error(`\npages: ${keys(pages).length} ids; first page fields: ${JSON.stringify(keys((pages as any)[keys(pages)[0]]))}`);

  // Tokens for the player page: ~/graphics/page/<pageId>.
  const pid = playerPage || keys(pages)[0];
  const graphics = await rtGet<Record<string, unknown>>(`graphics/page/${pid}`);
  const gSample = sampleChild(graphics);
  out.graphics = { page: pid, count: keys(graphics).length, sample: gSample };
  console.error(`\ngraphics/page/${pid}: ${keys(graphics).length} tokens; sample fields: ${JSON.stringify(gSample.fields)}`);

  // Paths / doors / windows for that page.
  for (const t of ["paths", "doors", "windows", "texts"]) {
    const v = await rtGet<Record<string, unknown>>(`${t}/page/${pid}`).catch(() => null);
    out[t] = v ? { count: keys(v).length, sample: sampleChild(v) } : null;
    console.error(`  ${t}/page/${pid}: ${v ? keys(v).length + " items; fields " + JSON.stringify(sampleChild(v).fields) : "<none>"}`);
  }

  // Characters + attributes location.
  const chars = await rtGet<Record<string, unknown>>("characters").catch(() => null);
  if (chars) {
    const cid = keys(chars)[0];
    out.characterListSample = { id: cid, fields: keys((chars as any)[cid]) };
    console.error(`\ncharacters: ${keys(chars).length}; list-entry fields: ${JSON.stringify(keys((chars as any)[cid]))}`);
    const blob = await rtGet<Record<string, unknown>>(`char-blobs/${cid}`).catch(() => null);
    if (blob) {
      out.charBlobKeys = keys(blob);
      console.error(`  char-blobs/${cid} keys: ${JSON.stringify(keys(blob))}`);
      const attribs = (blob as any).attribs || (blob as any).attributes;
      if (attribs) {
        const aSample = sampleChild(attribs);
        out.attribsSample = aSample;
        console.error(`  attribs: ${keys(attribs).length}; sample: ${JSON.stringify((attribs as any)[keys(attribs)[0]]).slice(0, 160)}`);
      }
    }
  }

  const dumpDir = path.resolve("./.tmp-test-data");
  mkdirSync(dumpDir, { recursive: true });
  const file = path.join(dumpDir, `rtdb-schema-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify(out, null, 2), "utf-8");
  console.error(`\nfull → ${file}`);
}

main().then(() => process.exit(0), (e) => { console.error("schema recon FAILED:", e); process.exit(1); });
