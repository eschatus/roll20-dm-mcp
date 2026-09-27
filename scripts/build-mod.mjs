#!/usr/bin/env node
// Build the paste-ready relay: mod-scripts/ai-relay.js → mod-scripts/.ai-relay.deploy.js
//
// The source is ~160KB of code and comments; the Roll20 Mod editor is a textarea with a size
// cap, so what a human pastes is the minified artifact. This is the browserless HALF of the old
// src/recon/release-mod.ts — the deploy half drove a browser against a live account and was
// deleted with #175. Deploying is still a hand-attended, per-campaign paste; this only produces
// the bytes to paste.
//
//   npm run build:mod            build + gate
//   npm run build:mod -- --verify  also run the emulator suite AGAINST the minified artifact
//
// esbuild mangles LOCALS only. The Roll20 sandbox globals (on, findObjs, sendChat, state, …) are
// free identifiers and survive, and so do this file's own top-level declarations — which matters,
// because the sandbox calls into them. es2019 keeps the output inside the sandbox engine.
import { execFileSync } from "child_process";
import { readFileSync, rmSync, statSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { buildSync } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = resolve(root, "mod-scripts/ai-relay.js");
const OUT = resolve(root, "mod-scripts/.ai-relay.deploy.js");
const versionOf = (code, what) => {
  const m = /AI_RELAY_VERSION\s*=\s*"([^"]+)"/.exec(code);
  if (!m) throw new Error(`${what}: AI_RELAY_VERSION not found — did it get renamed or inlined?`);
  return m[1];
};

const srcCode = readFileSync(SRC, "utf8");
const srcVersion = versionOf(srcCode, "source");

// Every gate below rejects the artifact. A rejected artifact must not survive at the documented
// paste path, where a human would paste it anyway — so a failed gate deletes it before exiting.
const reject = (why) => {
  rmSync(OUT, { force: true });
  console.error(`[build:mod] REJECTED — ${why}`);
  console.error(`[build:mod] deleted ${OUT}; nothing to paste.`);
  process.exit(1);
};

// Clear the previous artifact FIRST. If esbuild throws on changed source, the old build would
// otherwise survive at the paste path looking current (Devin, #233).
rmSync(OUT, { force: true });

// esbuild's JS API, not its CLI: node on Windows refuses to spawn a .cmd shim without a shell
// (EINVAL since the CVE-2024-27980 fix), and esbuild is already a devDependency here.
//
// tsconfigRaw "{}": without it esbuild reads the REPO's tsconfig.json, sees "strict": true
// (which implies alwaysStrict), and prepends a "use strict" directive the source never had —
// silently changing the semantics of every function in the sandbox. The relay is plain sandbox
// JS; the server's TypeScript settings have no business shaping it.
try {
  buildSync({ entryPoints: [SRC], outfile: OUT, minify: true, target: "es2019", tsconfigRaw: "{}", logLevel: "info" });
} catch (e) {
  reject(`esbuild failed: ${String((e && e.message) || e).split("\n")[0]}`);
}

// A bad minify must never reach a live campaign: a syntax error in the Mod editor takes the whole
// sandbox down, and the editor will happily accept it.
try {
  execFileSync(process.execPath, ["--check", OUT], { stdio: "inherit" });
} catch {
  reject("node --check failed on the minified output (see the syntax error above)");
}

const outCode = readFileSync(OUT, "utf8");

// The minifier must not ADD a directive prologue. "use strict" changes runtime semantics (sloppy
// assignments throw, `this` in plain calls is undefined), and it arrived once already via the
// repo tsconfig — so any leading directive the source lacks is a build fault, not a style nit.
const leadingDirective = (code) => {
  const body = code.replace(/^(?:\s+|\/\/[^\n]*\n?|\/\*[\s\S]*?\*\/)*/, "");
  const m = /^(["'])(use [^"']*)\1/.exec(body);
  return m ? m[2] : null;
};
const outDirective = leadingDirective(outCode);
if (outDirective && outDirective !== leadingDirective(srcCode)) {
  reject(`minified output begins with a "${outDirective}" directive the source does not have`);
}

// The version is the ONLY thing a DM can see to tell which build is deployed (the load banner and
// the ping handshake both read it), so a build that lost or changed it is worse than no build.
let outVersion;
try {
  outVersion = versionOf(outCode, "minified output");
} catch (e) {
  reject(e.message);
}
if (outVersion !== srcVersion) {
  reject(`version drift: source says ${srcVersion}, minified output says ${outVersion}`);
}

const before = statSync(SRC).size, after = statSync(OUT).size;
console.error(`[build:mod] ${(before / 1024).toFixed(0)}KB → ${(after / 1024).toFixed(0)}KB (${100 - Math.round((after * 100) / before)}% smaller), relay v${srcVersion}`);

if (process.argv.includes("--verify")) {
  // The real gate. node --check only proves it parses; this drives the minified bytes through the
  // same emulator suite the source passes, so mangling that broke a handler fails here.
  console.error("[build:mod] running the emulator suite against the MINIFIED artifact…");
  const vitest = resolve(root, "node_modules/vitest/vitest.mjs");   // the .mjs, not the .cmd shim
  try {
    execFileSync(process.execPath, [vitest, "run", "test/"], { stdio: "inherit", env: { ...process.env, AI_RELAY_PATH: OUT } });
  } catch {
    reject("the emulator suite failed against the minified artifact (see the failures above)");
  }
}

console.error(`[build:mod] paste ${OUT} into the campaign's Mod editor; verify the LOAD banner:`);
console.error(`[build:mod]   [GM_AI_Bridge] Relay script loaded (v${srcVersion})`);
