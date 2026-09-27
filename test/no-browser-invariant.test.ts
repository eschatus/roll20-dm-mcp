// ─────────────────────────────────────────────────────────────────────────────
// "Furnished, never driven" — the repo-wide no-browser invariant (#175, after #83/#179).
//
// test/relay-transport.test.ts already proves the RUNTIME dispatch never reaches a browser.
// This proves something different and broader: no file in this repository can DRIVE one at
// all. The gap was real — long after `release:mod`, `deploy_mod_script` and the Playwright
// relay were deleted, two live-diagnostic scripts in scripts/ still did
// `chromium.connectOverCDP("http://localhost:9222")` and evaluated code inside whatever
// Roll20 editor tab happened to be logged in. They passed every existing test: they are not
// on the relay path, and they import a package that isn't even a dependency, so nothing
// type-checked or executed them. A dev session running one would nevertheless have acted on a
// live campaign through an ambient logged-in profile — the exact blast radius #175 is about.
//
// Credentials here are FURNISHED (a harvested RT token read from the data dir, an upload cache),
// never minted; harvesting belongs to the gem, where a human is watching one visible window.
// A browser driver reappearing anywhere in this tree is that decision quietly reversing, so it
// fails here instead of in a live session.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

// Directories holding code that can actually run. docs/, wiki/ and skills/ are prose — they
// discuss the absent browser at length and must keep being allowed to.
const CODE_DIRS = ["src", "scripts", "test", "mod-scripts"];
const CODE_EXT = new Set([".ts", ".js", ".mjs", ".cjs", ".tsx"]);

// This file necessarily contains every pattern it bans.
const SELF = path.join("test", "no-browser-invariant.test.ts");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const abs = path.join(dir, entry);
    if (statSync(abs).isDirectory()) walk(abs, out);
    else if (CODE_EXT.has(path.extname(entry))) out.push(abs);
  }
  return out;
}

function codeFiles(): { rel: string; src: string }[] {
  const files: { rel: string; src: string }[] = [];
  for (const d of CODE_DIRS) {
    const abs = path.join(ROOT, d);
    let isDir = false;
    try { isDir = statSync(abs).isDirectory(); } catch { isDir = false; }
    if (!isDir) continue;
    for (const f of walk(abs)) {
      const rel = path.relative(ROOT, f);
      if (rel === SELF) continue;
      files.push({ rel, src: readFileSync(f, "utf8") });
    }
  }
  return files;
}

// Each pattern is a way to OBTAIN a browser, not a way to mention one. Built by concatenation
// only where a literal would make this file match its own rule via the exclusion above being
// the sole defence — the exclusion is the defence, kept explicit and single-purpose.
const BROWSER_DRIVERS: { name: string; re: RegExp }[] = [
  // Any import of the driver, static or dynamic, ESM or CJS.
  { name: 'import of "playwright"', re: /(?:from|require\s*\(|import\s*\()\s*["'](playwright|playwright-core|puppeteer|puppeteer-core)["']/ },
  // Attaching to an already-running browser over the DevTools protocol — the ambient-profile
  // path specifically: it needs no credential of its own because it borrows a logged-in one.
  { name: "connectOverCDP / CDP attach", re: /connectOverCDP|connect\s*\(\s*\{\s*browserWSEndpoint/ },
  // Launching one.
  { name: "browser launch", re: /\b(chromium|firefox|webkit)\s*\.\s*launch(PersistentContext)?\s*\(/ },
  // The remote-debugging port a previous incarnation of this repo opened, unauthenticated.
  { name: "remote debugging port", re: /--remote-debugging-port|localhost:9222|127\.0\.0\.1:9222/ },
];

describe("no-browser invariant — nothing in this repo can drive a browser (#175)", () => {
  const files = codeFiles();

  it("finds code to scan at all (guards against a silently empty sweep)", () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files.some(f => f.rel.startsWith(`src${path.sep}bridge`))).toBe(true);
  });

  for (const { name, re } of BROWSER_DRIVERS) {
    it(`no file uses ${name}`, () => {
      const hits = files.filter(f => re.test(f.src)).map(f => f.rel);
      expect(hits, `browser driver reintroduced in: ${hits.join(", ")}`).toEqual([]);
    });
  }

  it("package.json declares no browser-automation dependency", () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    const declared = Object.keys({
      ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies,
    });
    const banned = declared.filter(d => /^(playwright|puppeteer)/.test(d));
    expect(banned, `browser automation dependency declared: ${banned.join(", ")}`).toEqual([]);
  });

  it("declares no deploy script — Mod deploy is attended and out of band", () => {
    // `release:mod` drove Playwright to paste the relay into a live campaign's API console from
    // whatever session typed the command. Roll20 exposes no Mod-deployment API, so deploy stays
    // a human act; the repo must not hand an agent a one-word way to perform it.
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    const scripts = pkg.scripts ?? {};
    expect(Object.keys(scripts)).not.toContain("release:mod");
    // Judge a script by what its COMMAND does, not by its name: a future `release:notes` is
    // harmless, a script named anything that launches a browser driver or calls the deleted
    // deploy tools is not.
    const drivesBrowserOrDeploys =
      /(playwright|puppeteer|selenium|webdriver|chromium|chrome-remote-interface)|connectOverCDP|release-mod|deploy[_-]mod/i;
    const offending = Object.entries(scripts).filter(([, cmd]) => drivesBrowserOrDeploys.test(cmd));
    expect(offending, `browser/deploy npm script: ${offending.map(([k]) => k).join(", ")}`).toEqual([]);
    // The paste-ready BUILD is fine — it produces a file a human pastes; it deploys nothing.
    expect(scripts).toHaveProperty("build:mod");
    expect(drivesBrowserOrDeploys.test(scripts["build:mod"])).toBe(false);
  });
});
