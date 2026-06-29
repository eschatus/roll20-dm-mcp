// ─────────────────────────────────────────────────────────────────────────────
// Roll20 Mod sandbox emulator
//
// Implements just enough of the Roll20 Mod (API) global surface — getObj,
// findObjs, createObj, Campaign, sendChat, on, playerIsGM, log, state — over an
// in-memory object store, then loads the REAL mod-scripts/ai-relay.js into a Node
// `vm` context. This lets us drive `!ai-relay {json}` commands straight into the
// relay's chat:message handler and assert on the resulting game state + whispers,
// with no browser and no live Roll20.
//
// Determinism: dice (inline rolls) and the sandbox's Math.random are both seeded,
// so initiative rolls and epithet selection are reproducible across runs.
// ─────────────────────────────────────────────────────────────────────────────
import * as fs from "fs";
import * as path from "path";
import * as vm from "vm";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AI_RELAY_PATH = path.resolve(__dirname, "../mod-scripts/ai-relay.js");

// Keys Roll20 mirrors between a settable form and a read-only underscore form
// (createObj("graphic",{pageid}) is later read as get("_pageid")). We store both.
const MIRROR_KEYS = new Set(["type", "id", "pageid", "characterid", "subtype", "cardid"]);

// Deterministic PRNG (mulberry32).
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface R20Obj {
  id: string;
  get(prop: string): unknown;
  set(prop: string | Record<string, unknown>, value?: unknown): void;
  remove(): void;
}

export interface EmulatorOptions {
  seed?: number;
  gmPlayerId?: string;
}

export class Roll20Emulator {
  private store: R20Obj[] = [];
  private idCounter = 0;
  private handlers: Record<string, Array<(msg: unknown) => void>> = {};
  private resultByNonce = new Map<number, { data?: unknown; error?: string }>();
  private nonceCounter = Date.now();
  private gmIds = new Set<string>();
  private rng: () => number;
  private vmRng: () => number;

  readonly chatLog: Array<{ who: string; content: string; options?: unknown }> = [];
  readonly logs: unknown[][] = [];
  readonly state: Record<string, unknown> = {};
  readonly gmPlayerId: string;

  // The Campaign Backbone-style singleton (its own prop bag).
  readonly campaignModel: R20Obj;

  constructor(opts: EmulatorOptions = {}) {
    const seed = opts.seed ?? 0xC0FFEE;
    this.rng = makeRng(seed);
    this.vmRng = makeRng(seed ^ 0x9e3779b9);
    this.gmPlayerId = opts.gmPlayerId ?? "gm-player-1";
    this.gmIds.add(this.gmPlayerId);
    this.campaignModel = this.makeObj("campaign", { turnorder: "", playerpageid: "" }, "campaign-singleton");
    // The campaign singleton is not part of findObjs results.
    this.store.pop();
  }

  // ── Object model ────────────────────────────────────────────────────────────
  private genId(): string {
    return "-N" + (++this.idCounter).toString(36).padStart(10, "0");
  }

  private makeObj(type: string, props: Record<string, unknown>, forceId?: string): R20Obj {
    const id = forceId ?? this.genId();
    const bag: Record<string, unknown> = {};
    const self = this;
    const setProp = (k: string, v: unknown) => {
      bag[k] = v;
      const base = k.replace(/^_/, "");
      if (MIRROR_KEYS.has(base)) {
        bag[base] = v;
        bag["_" + base] = v;
      }
    };
    setProp("_type", type);
    setProp("id", id);
    const obj: R20Obj = {
      id,
      get(prop: string) {
        return bag[prop] !== undefined ? bag[prop] : "";
      },
      set(prop: string | Record<string, unknown>, value?: unknown) {
        if (typeof prop === "object") {
          for (const [k, v] of Object.entries(prop)) setProp(k, v);
        } else {
          setProp(prop, value);
        }
      },
      remove() {
        const i = self.store.indexOf(obj);
        if (i !== -1) self.store.splice(i, 1);
      },
    };
    for (const [k, v] of Object.entries(props)) setProp(k, v);
    this.store.push(obj);
    return obj;
  }

  // ── Roll20 globals (bound, handed to the vm sandbox) ─────────────────────────
  private createObj = (type: string, props: Record<string, unknown> = {}): R20Obj => {
    return this.makeObj(type, props);
  };

  private getObj = (type: string, id: string): R20Obj | undefined => {
    if (id === this.campaignModel.id) return this.campaignModel;
    return this.store.find((o) => o.get("_type") === type && o.id === id);
  };

  private findObjs = (query: Record<string, unknown> = {}): R20Obj[] => {
    return this.store.filter((o) =>
      Object.keys(query).every((k) => String(o.get(k)) === String(query[k]))
    );
  };

  private Campaign = (): R20Obj => this.campaignModel;

  private playerIsGM = (playerId: string): boolean => this.gmIds.has(playerId);

  private log = (...args: unknown[]): void => {
    this.logs.push(args);
  };

  private on = (event: string, handler: (msg: unknown) => void): void => {
    (this.handlers[event] ||= []).push(handler);
  };

  private sendChat = (
    speaking: string,
    input: string,
    callback?: ((ops: unknown[]) => void) | null,
    options?: unknown
  ): void => {
    this.chatLog.push({ who: speaking, content: input, options });

    // Result whisper from writeResult() — capture for relay() to return.
    const markerPos = input.indexOf("AIBRIDGE_RESULT:");
    if (markerPos !== -1) {
      const json = this.extractBalancedJson(input, markerPos + "AIBRIDGE_RESULT:".length);
      if (json) {
        try {
          const parsed = JSON.parse(json) as { nonce: number; data?: unknown; error?: string };
          this.resultByNonce.set(parsed.nonce, { data: parsed.data, error: parsed.error });
        } catch {
          /* ignore malformed */
        }
      }
      return;
    }

    // Roll callback paths. Roll20 replaces a `/roll <expr>` message's content with
    // the JSON roll result before invoking the callback; rollFormulas reads it via
    // JSON.parse(ops[0].content). Inline `[[expr]]` rolls (rollInitiativeForTokens)
    // instead arrive on ops[0].inlinerolls. Simulate both.
    if (typeof callback === "function") {
      const rollMatch = /^\/roll\s+(.+)$/.exec(input.trim());
      if (rollMatch) {
        const res = this.evalExpr(rollMatch[1]);
        callback([{ content: JSON.stringify(res), inlinerolls: [] }]);
        return;
      }
      const inlinerolls = this.evalInlineRolls(input);
      callback([{ inlinerolls, content: input }]);
    }
  };

  // ── Inline dice evaluation ───────────────────────────────────────────────────
  // Produces the Roll20 inline-roll shape the relay reads: each [[expr]] becomes
  // { results: { total, rolls: [{ type:"R", results:[{v}, ...] }, ...] } }.
  private evalInlineRolls(input: string): unknown[] {
    const rolls: unknown[] = [];
    const re = /\[\[(.+?)\]\]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(input)) !== null) {
      rolls.push({ results: this.evalExpr(m[1]), expression: m[1] });
    }
    return rolls;
  }

  private evalExpr(expr: string): { total: number; rolls: unknown[] } {
    // Split into signed terms: 1d20 + 3, 8d6, 2d6-1, ...
    const terms = expr.replace(/\s+/g, "").match(/[+-]?[^+-]+/g) ?? [];
    let total = 0;
    const rollGroups: unknown[] = [];
    for (const term of terms) {
      const sign = term.startsWith("-") ? -1 : 1;
      const body = term.replace(/^[+-]/, "");
      const dice = body.match(/^(\d*)d(\d+)$/i);
      if (dice) {
        const count = dice[1] ? parseInt(dice[1], 10) : 1;
        const sides = parseInt(dice[2], 10);
        const faces: Array<{ v: number }> = [];
        let sub = 0;
        for (let i = 0; i < count; i++) {
          const v = 1 + Math.floor(this.rng() * sides);
          faces.push({ v });
          sub += v;
        }
        total += sign * sub;
        rollGroups.push({ type: "R", dice: count, sides, results: faces });
      } else {
        const n = parseInt(body, 10) || 0;
        total += sign * n;
        rollGroups.push({ type: "M", expr: term });
      }
    }
    return { total, rolls: rollGroups };
  }

  private extractBalancedJson(text: string, start: number): string | null {
    if (text[start] !== "{") return null;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (esc) { esc = false; continue; }
      if (inStr) {
        if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === "{") depth++;
      if (c === "}" && --depth === 0) {
        // Mirrors the decode in src/bridge/rt-helpers.ts parseAibridge — writeResult() in
        // ai-relay.js HTML-entity-encodes "@{"/"[[" to keep Roll20's own chat pipeline from
        // live-evaluating echoed attribute text. Decode here so relay()'s parsed result matches
        // the original data, the same way the real RT/browser transports do.
        return text.slice(start, i + 1)
          .replace(/&#64;\{/g, "@{")
          .replace(/&#91;&#91;/g, "[[");
      }
    }
    return null;
  }

  // ── Loading + driving ────────────────────────────────────────────────────────
  load(): void {
    const code = fs.readFileSync(AI_RELAY_PATH, "utf-8");
    const seededMath: Math = Object.create(Math);
    (seededMath as { random: () => number }).random = () => this.vmRng();

    const sandbox: Record<string, unknown> = {
      getObj: this.getObj,
      findObjs: this.findObjs,
      createObj: this.createObj,
      Campaign: this.Campaign,
      sendChat: this.sendChat,
      on: this.on,
      playerIsGM: this.playerIsGM,
      // Z-order globals — Roll20 reorders the graphic within its layer. We don't
      // model z-order, so these are no-ops (enough to exercise toFront/toBack).
      toFront: () => {},
      toBack: () => {},
      log: this.log,
      state: this.state,
      Math: seededMath,
      // Underscore — Roll20's sandbox ships `_` as a global. ai-relay.js uses
      // `_.shuffle` and `_.invert`. We provide a faithful minimal shim rather than
      // the real module so shuffle draws from the SEEDED RNG (determinism). If the
      // relay starts using more `_` methods, add them here.
      _: {
        shuffle: (arr: unknown[]): unknown[] => {
          const a = [...arr];
          for (let i = a.length - 1; i > 0; i--) {
            const j = Math.floor(seededMath.random() * (i + 1));
            [a[i], a[j]] = [a[j], a[i]];
          }
          return a;
        },
        invert: (obj: Record<string, string>): Record<string, string> => {
          const r: Record<string, string> = {};
          for (const k of Object.keys(obj)) r[obj[k]] = k;
          return r;
        },
      },
      console,
      JSON,
      parseInt,
      parseFloat,
      isNaN,
      Date,
      setTimeout,
      clearTimeout,
    };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox, { filename: "ai-relay.js" });
    this.emit("ready");
  }

  emit(event: string, msg?: unknown): void {
    for (const h of this.handlers[event] ?? []) h(msg);
  }

  /** Dispatch a raw chat message into the relay (low-level). */
  dispatchChat(content: string, opts: { playerid?: string; who?: string; selected?: unknown[] } = {}): void {
    const msg = {
      type: "api",
      content,
      playerid: opts.playerid ?? this.gmPlayerId,
      who: opts.who ?? "gm (GM)",
      selected: opts.selected,
      inlinerolls: [],
    };
    this.emit("chat:message", msg);
  }

  /**
   * Run one relay action and return its result data, exactly as the TS bridge
   * would receive it. Throws on a relay error or missing result. By default the
   * sender is a GM; pass `playerid` to exercise the GM gate.
   */
  relay<T = unknown>(cmd: Record<string, unknown>, opts: { playerid?: string } = {}): T {
    const nonce = ++this.nonceCounter;
    this.resultByNonce.delete(nonce);
    const content = "!ai-relay " + JSON.stringify({ ...cmd, nonce });
    this.dispatchChat(content, { playerid: opts.playerid });
    const result = this.resultByNonce.get(nonce);
    if (!result) {
      throw new Error(`Relay produced no result for action '${cmd.action}' (nonce ${nonce})`);
    }
    if (result.error) throw new Error(`Relay error for '${cmd.action}': ${result.error}`);
    return result.data as T;
  }

  /**
   * Dispatch a relay command with a CALLER-SUPPLIED nonce and return the raw
   * result record ({} if none was produced). Used to exercise the sandbox's
   * same-nonce replay idempotency (resend the same nonce → echo, no re-run).
   */
  relayWithNonce(cmd: Record<string, unknown>, nonce: number, opts: { playerid?: string } = {}): { data?: unknown; error?: string } {
    const content = "!ai-relay " + JSON.stringify({ ...cmd, nonce });
    this.dispatchChat(content, { playerid: opts.playerid });
    return this.resultByNonce.get(nonce) ?? {};
  }

  // ── Scenario seeding helpers ─────────────────────────────────────────────────
  setPlayerPage(pageId: string): void {
    this.campaignModel.set("playerpageid", pageId);
  }

  addGm(playerId: string): void {
    this.gmIds.add(playerId);
  }

  /** Create a page-like id (Roll20 doesn't require a page object for our paths). */
  createPage(name = "Test Map"): string {
    const page = this.makeObj("page", { name });
    return page.id;
  }

  /** Create a token (graphic). Returns the object so tests can read/assert. */
  createToken(props: Record<string, unknown>): R20Obj {
    return this.createObj("graphic", {
      _subtype: "token",
      subtype: "token",
      layer: "objects",
      bar1_value: 0,
      bar1_max: 0,
      statusmarkers: "",
      left: 0,
      top: 0,
      width: 70,
      height: 70,
      controlledby: "",
      represents: "",
      gmnotes: "",
      ...props,
    });
  }

  /** Create a character sheet with the given attributes. Returns the character id. */
  createCharacter(name: string, attrs: Record<string, number | string> = {}, controlledby = ""): string {
    const char = this.createObj("character", { name, controlledby });
    for (const [k, v] of Object.entries(attrs)) {
      this.createObj("attribute", { characterid: char.id, name: k, current: v, max: "" });
    }
    return char.id;
  }

  /** Convenience: read a token's current props as a plain object for assertions. */
  tokenProps(id: string): Record<string, unknown> {
    const t = this.getObj("graphic", id);
    if (!t) throw new Error(`No token ${id}`);
    return {
      name: t.get("name"),
      bar1_value: t.get("bar1_value"),
      bar1_max: t.get("bar1_max"),
      statusmarkers: t.get("statusmarkers"),
      layer: t.get("layer"),
      left: t.get("left"),
      top: t.get("top"),
      aura1_radius: t.get("aura1_radius"),
      represents: t.get("represents"),
      gmnotes: t.get("gmnotes"),
    };
  }

  turnOrder(): Array<{ id: string; pr: string; custom: string; _pageid?: string }> {
    const raw = this.campaignModel.get("turnorder") as string;
    return raw ? JSON.parse(raw) : [];
  }
}
