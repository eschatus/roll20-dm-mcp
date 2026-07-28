// Reusable core of the golden-pairs Board model — extracted from eval-golden.ts so
// gen-traces.ts (the SFT trajectory generator) can drive the SAME stateful board/stub
// executor the eval grades against, instead of re-deriving a second copy that could
// silently drift from the calibrated conventions in docs/table-mechanics-golden-pairs.md.
//
// eval-golden.ts imports everything below; its own SCENARIO/playthrough/main stay put
// (they're golden-pairs-specific, not reusable), and its behavior/output is unchanged.

// ── Board model — three token classes, auras, zones with color ───────────────
export type Klass = "pc" | "sidekick" | "npc";

export interface Tok {
  id: string; name: string; klass: Klass; controlledby: string;
  bar1_value: number; bar1_max: number; statusmarkers: string; gmnotes: string;
  layer: string; aura1_radius: number;
}

export interface Zone { name: string; color?: string }

export interface Board { tokens: Tok[]; turnorder: { id: string; pr: string }[]; zones: Zone[]; chat: string[] }

// ── PC HP — mirrors rt-helpers.ts's %%PCHP%% gmnotes encoding ────────────────
export const PCHP_RE = /%%PCHP=({[\s\S]*?})%%/;

export const writePcHp = (gm: string, e: { current: number; max: number; name: string }) =>
  (gm.replace(PCHP_RE, "").trim() + ` %%PCHP=${JSON.stringify({ ...e, updated: 0 })}%%`).trim();

export const readPcHp = (gm: string): { current: number; max: number } | null => {
  const m = gm.match(PCHP_RE); if (!m) return null; try { return JSON.parse(m[1]); } catch { return null; }
};

// ── Token factory — shared by the fixed golden-pairs board and gen-traces' seeded
// random rosters, so both build tokens with byte-identical shape/defaults. ──────
export function makeTok(name: string, hp: number, klass: Klass): Tok {
  return {
    id: "tok-" + name.replace(/\s+/g, ""), name, klass,
    controlledby: klass === "npc" ? "" : "player-" + name.split(" ")[0].toLowerCase(),
    bar1_value: hp, bar1_max: hp, statusmarkers: "", layer: "objects", aura1_radius: 0,
    gmnotes: klass === "pc" ? writePcHp("", { current: hp, max: hp, name }) : "",
  };
}

// The fixed golden-pairs board (scenario 1, round 2 — see docs/table-mechanics-golden-pairs.md).
export function seedBoard(): Board {
  const tokens = [
    makeTok("Glint Klinkinski", 30, "pc"),
    makeTok("Tua", 27, "sidekick"),
    makeTok("Salros Eventide", 24, "sidekick"),
    makeTok("Water Elemental the Surging", 90, "npc"),
    makeTok("Kraken Priest A", 33, "npc"),
    makeTok("Kraken Priest B", 33, "npc"),
  ];
  // Glint acted last round, so he sits on top; "top of the order" = one advance → Salros.
  const order = ["Glint Klinkinski", "Salros Eventide", "Water Elemental the Surging", "Tua", "Kraken Priest A", "Kraken Priest B"];
  return {
    tokens,
    turnorder: order.map((n, i) => ({ id: tokens.find((t) => t.name === n)!.id, pr: String(20 - i) })),
    zones: [{ name: "Grease", color: "#88aa00" }],
    chat: [],
  };
}

// ── Marker / lookup helpers ───────────────────────────────────────────────────
export const find = (b: Board, n: unknown) =>
  b.tokens.find((t) => t.name.toLowerCase() === String(n ?? "").toLowerCase()) ||
  b.tokens.find((t) => t.name.toLowerCase().includes(String(n ?? "").toLowerCase()) && String(n ?? "").length > 2);

export const byRef = (b: Board, a: Record<string, unknown>) =>
  find(b, a.characterName) || b.tokens.find((x) => x.id === a.tokenId) || find(b, a.tokenId);

export const has = (t: Tok, cond: string) => t.statusmarkers.split(",").some((m) => m.toLowerCase().includes(cond));
export const markers = (t: Tok) => new Set(t.statusmarkers.split(",").filter(Boolean));
export const setMarkers = (t: Tok, s: Set<string>) => { t.statusmarkers = [...s].join(","); };

export const rosterFromBoard = (b: Board) => {
  const line = (t: Tok) => `- ${t.name}${has(t, "concentrating") ? " (concentrating on Bless)" : ""}`;
  return "PCs (true player characters — HP tracked, bar is Beyond20's):\n" +
    b.tokens.filter((t) => t.klass === "pc").map(line).join("\n") +
    "\nSIDEKICKS (player-controlled, but HP lives on token bar1):\n" +
    b.tokens.filter((t) => t.klass === "sidekick").map(line).join("\n") +
    "\nOTHER TOKENS (NPCs):\n" +
    b.tokens.filter((t) => t.klass === "npc").map(line).join("\n");
};

// ── Stub executor — routes HP by token CLASS (simulating the #132-fixed server) ──
export function stubExec(name: string, a: Record<string, unknown>, b: Board): string {
  const hpDelta = (t: Tok, amount: number, heal = false) => {
    if (t.klass === "pc") {
      const h = readPcHp(t.gmnotes)!;
      const nv = Math.max(0, Math.min(h.max, h.current + (heal ? amount : -amount)));
      t.gmnotes = writePcHp(t.gmnotes, { ...h, current: nv });
      return `${t.name} ${nv}/${h.max} (tracked)`;
    }
    t.bar1_value = Math.max(0, Math.min(t.bar1_max, t.bar1_value + (heal ? amount : -amount)));
    // Server-side threshold automation (#141/#144): symmetric wounded + auto-death at 0
    // for NPCs/sidekicks — the stub simulates the fixed server, mirroring its report text.
    const s = markers(t);
    let suffix = "";
    if (t.bar1_value === 0) { s.add("dead"); setMarkers(t, s); t.layer = "map"; return `${t.name} 0/${t.bar1_max} — DEAD (map layer)`; }
    if (t.bar1_value * 2 <= t.bar1_max) { s.add("wounded"); suffix = " — wounded"; }
    else { for (const m of [...s]) if (m.includes("wounded") || m.includes("bloodied")) s.delete(m); }
    setMarkers(t, s);
    return `${t.name} ${t.bar1_value}/${t.bar1_max}${suffix}`;
  };
  const applyConds = (t: Tok, add?: unknown, remove?: unknown) => {
    const s = markers(t);
    for (const c of (Array.isArray(add) ? add : [])) s.add(String(c).toLowerCase());
    for (const c of (Array.isArray(remove) ? remove : [])) for (const m of [...s]) if (m.includes(String(c).toLowerCase())) s.delete(m);
    setMarkers(t, s);
  };
  switch (name) {
    case "list_tokens": return JSON.stringify(b.tokens.map((t) => ({ id: t.id, name: t.name, controlledby: t.controlledby, layer: t.layer, hp: `${t.bar1_value}/${t.bar1_max}`, statusmarkers: t.statusmarkers })));
    case "get_token": { const t = byRef(b, a); return t ? JSON.stringify({ ...t }) : "not found"; }
    case "get_turn_order": return JSON.stringify(b.turnorder.map((e) => ({ ...e, name: b.tokens.find((t) => t.id === e.id)?.name })));
    case "get_token_markers": return JSON.stringify({ reserved: [], available: [] });
    case "list_zones": return JSON.stringify(b.zones);
    case "find_tokens_in_range": return JSON.stringify(b.tokens.filter((t) => t.klass === "npc" && t.layer === "objects").map((t) => t.name));
    case "update_token_hp": {
      const t = byRef(b, a); if (!t) return "token not found";
      applyConds(t, a.addConditions, a.removeConditions);
      if (a.damage != null) return hpDelta(t, Number(a.damage));
      if (a.heal != null) return hpDelta(t, Number(a.heal), true);
      if (a.setHp != null) {
        if (t.klass === "pc") { const h = readPcHp(t.gmnotes)!; t.gmnotes = writePcHp(t.gmnotes, { ...h, current: Number(a.setHp) }); return `${t.name} ${a.setHp} (tracked)`; }
        t.bar1_value = Number(a.setHp); return `${t.name} ${t.bar1_value}/${t.bar1_max}`;
      }
      return a.addConditions || a.removeConditions ? `${t.name} conditions updated` : "no hp op";
    }
    case "update_hp_many": {
      const names = (a.names as string[]) || b.tokens.filter((t) => a.nameMatch && t.name.toLowerCase().includes(String(a.nameMatch).toLowerCase())).map((t) => t.name);
      return names.map((n) => { const t = find(b, n); return t ? hpDelta(t, Number(a.damage ?? a.heal ?? 0), a.heal != null) : `${n}?`; }).join(", ");
    }
    case "set_token_marker": {
      const t = byRef(b, a); if (!t) return "token not found";
      const cond = String(a.condition).toLowerCase(); const s = markers(t);
      // Set-semantics (per #133): active=true adds (idempotent), false removes.
      if (a.active === false) { for (const m of [...s]) if (m.includes(cond)) s.delete(m); } else s.add(cond);
      setMarkers(t, s);
      return `${t.name}: ${cond} ${a.active === false ? "cleared" : "applied"}`;
    }
    case "kill_token": {
      const t = byRef(b, a); if (!t) return "token not found";
      const s = markers(t); s.add("dead"); setMarkers(t, s); t.layer = "map";
      return `${t.name} marked dead + moved to map layer`;
    }
    case "resolve_aoe": {
      const targets = (a.targetNames as string[]) || b.tokens.filter((t) => t.klass === "npc").map((t) => t.name);
      const dmgN = Number(a.damage) || 0;
      return `${a.label ?? "AoE"}: ` + targets.map((n) => { const t = find(b, n); return t ? hpDelta(t, dmgN) : `${n}?`; }).join("; ");
    }
    case "create_zone": b.zones.push({ name: String(a.name), color: a.color ? String(a.color) : undefined }); return `zone "${a.name}" created`;
    case "clear_zone": { const before = b.zones.length; b.zones = b.zones.filter((z) => z.name.toLowerCase() !== String(a.name).toLowerCase()); return b.zones.length < before ? `zone "${a.name}" cleared` : `no zone "${a.name}"`; }
    case "advance_turn": { const e = b.turnorder.shift(); if (e) b.turnorder.push(e); const cur = b.tokens.find((t) => t.id === b.turnorder[0]?.id); return `advanced — now ${cur?.name ?? "?"}`; }
    case "set_token_props": {
      const t = byRef(b, a); if (!t) return "token not found";
      if (a.layer != null) t.layer = String(a.layer);
      if (a.aura1_radius != null) t.aura1_radius = Number(a.aura1_radius) || 0;
      return `${t.name} props set`;
    }
    case "roll_dice": return "rolled (see chat)";
    case "send_narration": b.chat.push(String(a.text ?? "")); return "(narrated)";
    case "batch_exec": {
      // Execute faithfully — a swallowed batch would hide exactly the mutations we grade.
      const arr = Object.values(a).find((v) => Array.isArray(v) && v.every((x) => x && typeof x === "object")) as Record<string, unknown>[] | undefined;
      if (!arr) return "(batch: nothing to run)";
      return arr.map((c) => {
        const tool = String(c.tool ?? c.name ?? c.action ?? "");
        const args = (c.args ?? c.params ?? c.input ?? c) as Record<string, unknown>;
        return tool ? stubExec(tool, args, b) : "(?)";
      }).join(" | ");
    }
    case "mark_dying": {
      const t = byRef(b, a); if (!t) return "token not found";
      if (t.klass !== "pc") return `${t.name} is not a PC — NPCs/sidekicks just die; use kill_token`;
      const s = markers(t); s.add("prone"); s.add("unconscious");
      let casc = "";
      if (s.has("concentrating")) { s.delete("concentrating"); t.aura1_radius = 0; casc = " (concentration broken)"; }
      setMarkers(t, s);
      return `${t.name} is dying — prone + unconscious, on the token layer${casc}`;
    }
    case "break_concentration": {
      const t = byRef(b, a); if (!t) return "token not found";
      const s = markers(t); for (const m of [...s]) if (m.includes("concentrating")) s.delete(m);
      setMarkers(t, s); t.aura1_radius = 0;
      return `${t.name}: concentration broken — marker cleared, aura 0`;
    }
    case "roll_initiative": return "(initiative rolled)";
    case "plan_all_tactics": case "get_mob_plans": return "(tactics ready)";
    default: return `(stub: ${name} ok)`;
  }
}

// Common per-step conversation context (tool calls + assistant prose emitted this step).
export interface Ctx { calls: string[]; texts: string[] }
