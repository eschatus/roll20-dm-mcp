// Tiny local recorder for the A/B corpus — no Electron, no native deps.
//
// Serves recorder.html (which reuses the gem's exact capture + encodeWav, so clips are
// byte-identical to production) and writes each recording straight into data/ab-clips/
// as <name>.wav + <name>.txt (the reference you type). Cross-platform: works on your
// Windows rig and Bill's M4 in any browser — getUserMedia is allowed on http://localhost.
//
// Run:  npm run record   →   open the printed URL, hold to record, type what you said, Save.
import * as http from "http";
import * as fs from "fs";
import * as path from "path";

const CLIP_DIR = process.env.DMW_AB_CLIPS || path.join(__dirname, "..", "data", "ab-clips");
const PORT = Number(process.env.DMW_RECORD_PORT) || 8137;
const MAX_BYTES = (Number(process.env.DMW_SAVE_CLIPS_MAX_MB) || 1024) * 1024 * 1024;
const MAX_FILES = Number(process.env.DMW_SAVE_CLIPS_MAX_FILES) || 250;
const PAGE = path.join(__dirname, "recorder.html");

fs.mkdirSync(CLIP_DIR, { recursive: true });

function audioFiles(): string[] {
  return fs.readdirSync(CLIP_DIR).filter((f) => /\.(wav|mp3|ogg|flac)$/i.test(f));
}
function usedBytes(files: string[]): number {
  return files.reduce((n, f) => { try { return n + fs.statSync(path.join(CLIP_DIR, f)).size; } catch { return n; } }, 0);
}
// Keep only safe basename chars; no extension, no path traversal.
function sanitize(name: string): string {
  return path.basename(name).replace(/\.[^.]*$/, "").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let b = ""; req.on("data", (c) => { b += c; if (b.length > 64 * 1024 * 1024) req.destroy(); });
    req.on("end", () => resolve(b)); req.on("error", reject);
  });
}
const json = (res: http.ServerResponse, code: number, obj: unknown) => {
  res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj));
};

const server = http.createServer(async (req, res) => {
  try {
    const url = (req.url || "/").split("?")[0];

    if (req.method === "GET" && url === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(fs.readFileSync(PAGE));
    }

    if (req.method === "GET" && url === "/list") {
      const files = audioFiles();
      return json(res, 200, { count: files.length, bytes: usedBytes(files), maxBytes: MAX_BYTES, maxFiles: MAX_FILES });
    }

    if (req.method === "GET" && url === "/prompts") {
      const file = process.env.DMW_AB_PROMPTS || path.join(__dirname, "ab-prompts.txt");
      let lines: string[] = [];
      try {
        lines = fs.readFileSync(file, "utf-8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
      } catch { /* none → free-record mode */ }
      return json(res, 200, { prompts: lines });
    }

    if (req.method === "POST" && url === "/save") {
      const { name, ref, wavB64 } = JSON.parse(await readBody(req)) as { name?: string; ref?: string; wavB64?: string };
      const base = sanitize(name || "");
      if (!base) return json(res, 400, { ok: false, error: "invalid name" });
      if (!wavB64) return json(res, 400, { ok: false, error: "no audio" });
      const buf = Buffer.from(wavB64, "base64");

      const files = audioFiles();
      if (files.length >= MAX_FILES) return json(res, 409, { ok: false, error: `corpus full (${files.length} files ≥ ${MAX_FILES} cap) — prune data/ab-clips/` });
      if (usedBytes(files) + buf.length > MAX_BYTES) return json(res, 409, { ok: false, error: `corpus full (would exceed ${(MAX_BYTES / 1e6).toFixed(0)} MB cap) — prune data/ab-clips/` });

      fs.writeFileSync(path.join(CLIP_DIR, base + ".wav"), buf);
      if (ref && ref.trim()) fs.writeFileSync(path.join(CLIP_DIR, base + ".txt"), ref.trim());
      console.error(`[record] saved ${base}.wav (${(buf.length / 1024) | 0} KB)${ref && ref.trim() ? " + ref" : ""}`);
      return json(res, 200, { ok: true, file: base + ".wav" });
    }

    res.writeHead(404); res.end("not found");
  } catch (e) {
    json(res, 500, { ok: false, error: (e as Error).message });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.error(`\n  🎙  A/B clip recorder → http://localhost:${PORT}\n      saving to ${CLIP_DIR}  (cap ${(MAX_BYTES / 1e6).toFixed(0)} MB / ${MAX_FILES} files)\n      Ctrl+C to stop. Then: npm run ab:stt\n`);
});
