// GM_AI_Bridge — Roll20 Mod relay script
// Deploy this in your campaign's Mod (API) editor under Settings > API Scripts.
//
// No setup required — the MCP server sends commands via !ai-relay chat commands,
// and results are written back to Campaign properties.

// Results are whispered to GM, wrapped in a CSS-targetable div so the campaign
// stylesheet can hide or style them without touching legitimate whispers.
function writeResult(nonce, data, error) {
  const payload = error
    ? JSON.stringify({ nonce, error: String(error) })
    : JSON.stringify({ nonce, data });
  // noarchive: won't appear in the persistent chat log.
  // display:none: hides any transient flash in the current session.
  // Playwright still reads textContent from hidden DOM elements.
  sendChat("GM-AI-Bridge",
    "/w gm <div style='display:none'>AIBRIDGE_RESULT:" + payload + "</div>",
    null,
    { noarchive: true }
  );
}

// --- Globals ---
const CHAT_BUFFER = [];
const CHAT_BUFFER_MAX = 100;
let DM_INBOX = [];
const DM_INBOX_MAX = 50;
let ROUND_NUMBER = 0;
let ROUND_FIRST_TOKEN_ID = null;
let TURN_HOOK_ENABLED = false;
let MOB_PLANS = {};  // tokenId → { html: string }, consumed at each mob's turn start

// --- Helpers ---

// Epithet word banks for disambiguating duplicate-named tokens at initiative roll time.
// Matched by substring against the token name (case-insensitive).
const MONSTER_EPITHETS = {
  goblin:    ["Sniveling","Savage","One-Eyed","Stinking","Cowardly","Bold","Gap-Toothed"],
  hobgoblin: ["Scarred","Disciplined","Ruthless","Iron-Fisted","Veteran","Grim"],
  bugbear:   ["Hulking","Sneaking","Slavering","Brutal","Heavy-Handed"],
  orc:       ["Berserk","Scarred","Bloodied","Raging","Brutal","Wailing"],
  gnoll:     ["Cackling","Slavering","Mangy","Frenzied","Bone-Crunching"],
  kobold:    ["Scurrying","Trap-Setting","Yapping","Scaled","Venomous"],
  zombie:    ["Shambling","Rotting","Bloated","Wailing","Ancient","Lurching"],
  ghoul:     ["Ravenous","Clawing","Foul","Swift","Gibbering"],
  ghast:     ["Reeking","Ancient","Savage","Wretched"],
  skeleton:  ["Brittle","Cursed","Clacking","Headless","Armored","Ancient"],
  specter:   ["Wailing","Pale","Shrieking","Vengeful","Keening"],
  wraith:    ["Ancient","Hungry","Silent","Seething","Cold"],
  vampire:   ["Pale","Ancient","Wrathful","Charming","Bloodthirsty"],
  wolf:      ["Hungry","Scarred","Black","Limping","Snarling","Gaunt"],
  werewolf:  ["Howling","Feral","Maddened","Hulking","Slavering"],
  rat:       ["Diseased","Scuttling","Mangy","Bloated","Foul"],
  bat:       ["Screeching","Swooping","Blood-Mad","Pale"],
  spider:    ["Bloated","Venomous","Ancient","Lurking","Bristling"],
  cultist:   ["Zealous","Frenzied","Devoted","Screaming","Hollow-Eyed"],
  guard:     ["Nervous","Grizzled","Corrupt","Loyal","Sweating"],
  bandit:    ["Scarred","Desperate","Cunning","Ruthless","Limping"],
  troll:     ["Regenerating","Stinking","Ancient","Howling","Massive"],
  ogre:      ["Bellowing","Stupid","Hungry","Scarred","Club-Fisted"],
};
const GENERIC_EPITHETS = [
  "Wrathful","Skulking","Wretched","Ravenous","Frenzied","Ancient","Withered",
  "Relentless","Cunning","Desperate","Scarred","Hungry","Pale","Lurking","Maddened",
  "Bloodied","Howling","Silent","Swift","Hollow-Eyed","Twisted","Gaunt",
];

// Draw a circle as a 36-point polygon path. Returns Roll20 path string.
// Path points are relative to the bounding box top-left corner.
// The bounding box is width=height=2*radiusPx, so center of circle = (radiusPx, radiusPx).
function makeCirclePath(radiusPx) {
  let r = radiusPx;
  let pts = [];
  for (let i = 0; i <= 36; i++) {
    let angle = (i / 36) * 2 * Math.PI;
    let x = r + r * Math.cos(angle);
    let y = r + r * Math.sin(angle);
    pts.push([i === 0 ? "M" : "L", Math.round(x * 100) / 100, Math.round(y * 100) / 100]);
  }
  pts.push(["Z"]);
  return JSON.stringify(pts);
}

function getMonsterEpithets(tokenName) {
  let lower = tokenName.toLowerCase();
  let keys = Object.keys(MONSTER_EPITHETS);
  for (let i = 0; i < keys.length; i++) {
    if (lower.indexOf(keys[i]) !== -1) return MONSTER_EPITHETS[keys[i]];
  }
  return GENERIC_EPITHETS;
}

const CONDITION_MARKERS = {
  dead:          "Unconscious::4444317",
  unconscious:   "Unconscious::4444317",
  wounded:       "Wounded::4444333",
  poisoned:      "Poisoned::4444329",
  blinded:       "Blinded::4444318",
  charmed:       "Charmed::4444320",
  deafened:      "Deafened::4444321",
  frightened:    "Feared::4444323",
  grappled:      "Grappled::4444314",
  incapacitated: "Incapacitated::4444325",
  invisible:     "Invisible::4444344",
  paralyzed:     "Paralyzed::4444327",
  petrified:     "Petrified::4444328",
  prone:         "Prone::4444315",
  restrained:    "Restrained::4444316",
  stunned:       "Stunned::4444331",
  exhaustion:    "Exhausted::4444322",
};

function setConditionAttr(charId, conditionSet) {
  let condStr = Array.from(conditionSet).join(",");
  let existing = findObjs({ _type: "attribute", _characterid: charId, name: "active_conditions" });
  if (existing.length > 0) {
    existing[0].set("current", condStr);
  } else {
    createObj("attribute", { characterid: charId, name: "active_conditions", current: condStr });
  }
}

// Synchronous operation executor used by batchExec.
// Only sync-safe actions here — no sendChat callbacks.
function runBatchOp(action, args) {
  switch (action) {
    case "setTokenBar": {
      let t = getObj("graphic", args.tokenId);
      if (!t) throw new Error("Token not found: " + args.tokenId);
      let p = { bar1_value: args.value };
      if (args.max !== undefined) p.bar1_max = args.max;
      t.set(p);
      return { ok: true };
    }
    case "setTokenProps": {
      let t = getObj("graphic", args.tokenId);
      if (!t) throw new Error("Token not found: " + args.tokenId);
      t.set(args.props || {});
      return { ok: true };
    }
    case "toggleCondition": {
      let t = getObj("graphic", args.tokenId);
      if (!t) throw new Error("Token not found: " + args.tokenId);
      let cond = (args.condition || "").toLowerCase();
      let marker = CONDITION_MARKERS[cond] || cond;
      let ms = new Set((t.get("statusmarkers") || "").split(",").filter(Boolean));
      if (args.active) ms.add(marker); else ms.delete(marker);
      t.set("statusmarkers", Array.from(ms).join(","));
      if (args.charId) {
        let existing = findObjs({ _type: "attribute", _characterid: args.charId, name: "active_conditions" });
        let condList = existing.length > 0 ? (existing[0].get("current") || "").split(",").filter(Boolean) : [];
        let cs = new Set(condList);
        if (args.active) cs.add(cond); else cs.delete(cond);
        setConditionAttr(args.charId, cs);
      }
      return { ok: true, marker: marker };
    }
    case "syncConditionsToToken": {
      let t = getObj("graphic", args.tokenId);
      if (!t) throw new Error("Token not found: " + args.tokenId);
      let activeSet = new Set((args.conditions || []).map(function(c) { return c.toLowerCase(); }));
      let markerSet = new Set((t.get("statusmarkers") || "").split(",").filter(Boolean));
      let allKnown = new Set();
      Object.keys(CONDITION_MARKERS).forEach(function(c) {
        let tag = CONDITION_MARKERS[c];
        allKnown.add(tag);
        let dn = tag.split("::")[0];
        allKnown.add(dn);
        allKnown.add(dn.toLowerCase());
      });
      allKnown.forEach(function(m) { markerSet.delete(m); });
      activeSet.forEach(function(c) {
        let m = CONDITION_MARKERS[c];
        if (m) markerSet.add(m);
      });
      t.set("statusmarkers", Array.from(markerSet).join(","));
      if (args.charId) setConditionAttr(args.charId, activeSet);
      return { ok: true, conditions: Array.from(activeSet) };
    }
    case "getTokenById": {
      let t = getObj("graphic", args.tokenId);
      if (!t) return null;
      return {
        id: t.id, name: t.get("name"),
        bar1_value: t.get("bar1_value"), bar1_max: t.get("bar1_max"),
        statusmarkers: t.get("statusmarkers"),
        left: t.get("left"), top: t.get("top"),
        represents: t.get("represents"), controlledby: t.get("controlledby"),
        layer: t.get("layer"),
      };
    }
    case "setTurnOrder": {
      Campaign().set("turnorder", JSON.stringify(args.turnorder || []));
      return { ok: true };
    }
    default:
      throw new Error("batchExec: unsupported action '" + action + "'. Supported: setTokenBar, setTokenProps, toggleCondition, syncConditionsToToken, getTokenById, setTurnOrder");
  }
}

on("chat:message", function (msg) {
  // Buffer all non-relay messages (captures Beyond20 dice rolls, player chat, etc.)
  if (msg.content && typeof msg.content === "string" && !msg.content.startsWith("!ai-relay")) {
    CHAT_BUFFER.push({
      who: msg.who || "",
      type: msg.type || "",
      content: msg.content.slice(0, 600),
      inlinerolls: (msg.inlinerolls || []).map(function(r) {
        return { expression: r.expression, total: r.results ? r.results.total : null };
      }),
      timestamp: Date.now(),
    });
    if (CHAT_BUFFER.length > CHAT_BUFFER_MAX) CHAT_BUFFER.shift();
  }

  // Player turn preloading / queries via !dm
  if (msg.type === "api" && msg.content && msg.content.startsWith("!dm ")) {
    let dmText = msg.content.slice(4).trim();
    if (dmText) {
      let isQuery = /^(what|who|how|is|am|are|do|does|can|did|\?)/i.test(dmText) || dmText.endsWith("?");
      DM_INBOX.push({
        who: msg.who || "",
        playerid: msg.playerid || "",
        content: dmText,
        type: isQuery ? "query" : "intent",
        timestamp: Date.now(),
      });
      if (DM_INBOX.length > DM_INBOX_MAX) DM_INBOX.shift();
      sendChat("Initiative", "/desc 🎲 **" + (msg.who || "Someone") + "** has set their mind to an action.");
      let ackVerb = isQuery ? "Got your question — I'll answer shortly." : "Got it — I'll have this ready for your turn.";
      sendChat("GM-AI-Bridge", "/w " + (msg.who || "gm") + " " + ackVerb + " (" + dmText + ")", null, { noarchive: true });
    }
    return;
  }

  if (msg.type !== "api") return;

  if (!msg.content.startsWith("!ai-relay ")) return;

  let cmd;
  try {
    cmd = JSON.parse(msg.content.slice("!ai-relay ".length));
  } catch (e) {
    return;
  }

  const { action, nonce, ...args } = cmd;
  const senderPlayerId = msg.playerid || "";

  log("[GM_AI_Bridge] action=" + action + " nonce=" + nonce);

  try {
    switch (action) {
      case "getTokens": {
        const tokens = findObjs({ _type: "graphic", _pageid: args.pageId });
        const result = tokens.map((t) => ({
          id: t.id,
          name: t.get("name"),
          bar1_value: t.get("bar1_value"),
          bar1_max: t.get("bar1_max"),
          statusmarkers: t.get("statusmarkers"),
          layer: t.get("layer"),
          imgsrc: t.get("imgsrc"),
          left: t.get("left"),
          top: t.get("top"),
          width: t.get("width"),
          height: t.get("height"),
          represents: t.get("represents") || "",
          controlledby: t.get("controlledby") || "",
        }));
        writeResult(nonce, result);
        break;
      }

      case "setTokenBar": {
        const token = getObj("graphic", args.tokenId);
        if (!token) throw new Error(`Token not found: ${args.tokenId}`);
        token.set({
          bar1_value: args.value,
          ...(args.max !== undefined ? { bar1_max: args.max } : {}),
        });
        writeResult(nonce, { ok: true });
        break;
      }

      case "setStatusMarker": {
        const token = getObj("graphic", args.tokenId);
        if (!token) throw new Error(`Token not found: ${args.tokenId}`);
        const current = token.get("statusmarkers") || "";
        const markers = current ? current.split(",") : [];
        if (args.active && !markers.includes(args.marker)) {
          markers.push(args.marker);
        } else if (!args.active) {
          const idx = markers.indexOf(args.marker);
          if (idx !== -1) markers.splice(idx, 1);
        }
        token.set("statusmarkers", markers.join(","));
        writeResult(nonce, { ok: true });
        break;
      }

      case "createToken": {
        const token = createObj("graphic", {
          _pageid: args.pageId,
          imgsrc: args.imgsrc,
          name: args.name,
          layer: args.layer || "tokens",
          left: args.left || 70,
          top: args.top || 70,
          width: args.width || 70,
          height: args.height || 70,
          bar1_value: args.bar1_value || 0,
          bar1_max: args.bar1_max || 0,
          showname: true,
          showplayers_name: true,
          showplayers_bar1: true,
        });
        writeResult(nonce, { id: token.id });
        break;
      }

      case "createPage": {
        // Roll20 API does not support createObj("page") — pages must be created manually in the UI.
        throw new Error("Roll20 API does not allow creating pages programmatically. Create the page manually in the Roll20 page navigator, then pass its pageId.");
      }

      case "createPath": {
        const pathObj = createObj("path", {
          pageid: args.pageId,
          layer: args.layer || "walls",
          path: args.path,
          stroke: args.stroke || "#000000",
          stroke_width: args.stroke_width || 5,
          fill: args.fill || "transparent",
          left: args.left,
          top: args.top,
          width: args.width,
          height: args.height,
          rotation: args.rotation || 0,
          scaleX: 1,
          scaleY: 1,
          controlledby: "",
        });
        if (!pathObj) throw new Error("createObj('path') returned undefined — check pageid and path format");
        writeResult(nonce, { id: pathObj.id });
        break;
      }

      case "createPaths": {
        // Batch create — avoids one relay round-trip per path.
        const results = (args.paths || []).map((p) => {
          const pathObj = createObj("path", {
            pageid: args.pageId,
            layer: p.layer || args.layer || "walls",
            path: p.path,
            stroke: p.stroke || args.stroke || "#000000",
            stroke_width: p.stroke_width || args.stroke_width || 5,
            fill: p.fill || args.fill || "transparent",
            left: p.left,
            top: p.top,
            width: p.width,
            height: p.height,
            rotation: p.rotation || 0,
            scaleX: 1,
            scaleY: 1,
            controlledby: "",
          });
          return pathObj ? { id: pathObj.id } : { error: "createObj returned undefined" };
        });
        writeResult(nonce, results);
        break;
      }

      case "getWalls": {
        // Read pathv2 DL barrier objects (Latest VTT Engine / UDL) from a page.
        let walls = findObjs({ _type: "pathv2", _pageid: args.pageId, layer: "walls" });
        writeResult(nonce, walls.map(function(w) {
          return {
            id: w.id,
            points: w.get("points"),
            x: w.get("x"),
            y: w.get("y"),
            barrierType: w.get("barrierType"),
            shape: w.get("shape"),
          };
        }));
        break;
      }

      case "debugPage": {
        // Enumerate what types of objects exist on a page — helps diagnose object storage.
        let types = ["path", "pathv2", "graphic", "wall", "text", "door", "window"];
        let summary = {};
        types.forEach(function(t) {
          let objs = findObjs({ _type: t, _pageid: args.pageId });
          summary[t] = { count: objs.length };
          if (objs.length && objs.length <= 5) {
            summary[t].sample = objs.slice(0, 3).map(function(o) {
              return { id: o.id, layer: o.get("layer"), barrierType: o.get("barrierType"), shape: o.get("shape") };
            });
          }
        });
        writeResult(nonce, summary);
        break;
      }

      case "createWalls": {
        // Create path objects on the walls layer with a custom stroke color.
        // path objects respect stroke color in the DL editor; pathv2 does not.
        // Each wall: { x1, y1, x2, y2, stroke? } in page pixel coordinates.
        let wallResults = (args.walls || []).map(function(w) {
          let minX = Math.min(w.x1, w.x2);
          let minY = Math.min(w.y1, w.y2);
          let wallObj = createObj("path", {
            pageid: args.pageId,
            layer: "walls",
            path: JSON.stringify([["M", w.x1 - minX, w.y1 - minY], ["L", w.x2 - minX, w.y2 - minY]]),
            left: (w.x1 + w.x2) / 2,
            top:  (w.y1 + w.y2) / 2,
            width:  Math.abs(w.x2 - w.x1),
            height: Math.abs(w.y2 - w.y1),
            stroke: w.stroke || args.stroke || "#FFFF00",
            stroke_width: 5,
            fill: "transparent",
            rotation: 0,
            scaleX: 1,
            scaleY: 1,
            controlledby: "",
          });
          return wallObj ? { id: wallObj.id } : { error: "createObj('path') returned undefined" };
        });
        writeResult(nonce, wallResults);
        break;
      }

      case "createDLDoors": {
        // Create native Roll20 DL door objects. Coordinates in page pixels; y is negated for Roll20.
        // Each door: { x, y, x0, y0, x1, y1, color? } — x/y center, x0/y0 and x1/y1 endpoints (pre-negated).
        let doorResults = (args.doors || []).map(function(d) {
          let obj = createObj("door", {
            pageid: args.pageId,
            x: d.x,
            y: d.y,
            path: { handle0: { x: d.x0, y: d.y0 }, handle1: { x: d.x1, y: d.y1 } },
            color: d.color || "#FF0000",
            isOpen: false,
            isLocked: false,
          });
          return obj ? { id: obj.id } : { error: "createObj('door') returned undefined" };
        });
        writeResult(nonce, doorResults);
        break;
      }

      case "createDLWindows": {
        // Create native Roll20 DL window objects. Same coordinate convention as createDLDoors.
        let windowResults = (args.windows || []).map(function(w) {
          let obj = createObj("window", {
            pageid: args.pageId,
            x: w.x,
            y: w.y,
            path: { handle0: { x: w.x0, y: w.y0 }, handle1: { x: w.x1, y: w.y1 } },
            color: w.color || "#00FFFF",
            isOpen: false,
            isLocked: false,
          });
          return obj ? { id: obj.id } : { error: "createObj('window') returned undefined" };
        });
        writeResult(nonce, windowResults);
        break;
      }

      case "createGraphic": {
        const graphic = createObj("graphic", {
          pageid: args.pageId,
          layer: args.layer || "map",
          imgsrc: args.imgsrc,
          name: args.name || "",
          left: args.left,
          top: args.top,
          width: args.width,
          height: args.height,
          rotation: args.rotation || 0,
          controlledby: "",
          showname: false,
        });
        if (!graphic) throw new Error("createObj('graphic') returned undefined");
        writeResult(nonce, { id: graphic.id });
        break;
      }

      case "setPageBackground": {
        const page = getObj("page", args.pageId);
        if (!page) throw new Error(`Page not found: ${args.pageId}`);
        page.set({ background_color: args.color || "#ffffff" });
        writeResult(nonce, { ok: true });
        break;
      }

      case "listPages": {
        const pages = findObjs({ _type: "page" });
        writeResult(nonce, pages.map((p) => ({
          id: p.id,
          name: p.get("name"),
          width: p.get("width"),
          height: p.get("height"),
        })));
        break;
      }

      case "setPageProps": {
        const page = getObj("page", args.pageId);
        if (!page) throw new Error(`Page not found: ${args.pageId}`);
        const props = {};
        if (args.name !== undefined) props.name = args.name;
        if (args.width !== undefined) props.width = args.width;
        if (args.height !== undefined) props.height = args.height;
        if (args.scale_number !== undefined) props.scale_number = args.scale_number;
        if (args.scale_units !== undefined) props.scale_units = args.scale_units;
        if (args.showgrid !== undefined) props.showgrid = args.showgrid;
        if (args.background_color !== undefined) props.background_color = args.background_color;
        page.set(props);
        writeResult(nonce, { ok: true, width: page.get("width"), height: page.get("height") });
        break;
      }

      case "getPaths": {
        // Read back all path/graphic objects from a page. If layer is omitted, returns all layers.
        let query = { _pageid: args.pageId };
        if (args.layer) query.layer = args.layer;
        let paths = findObjs(Object.assign({ _type: "path" }, query));
        let graphics = args.includeGraphics ? findObjs(Object.assign({ _type: "graphic" }, query)) : [];
        let results = paths.map(function(p) {
          return {
            type: "path",
            id: p.id,
            layer: p.get("layer"),
            path: p.get("path"),
            left: p.get("left"),
            top: p.get("top"),
            width: p.get("width"),
            height: p.get("height"),
            rotation: p.get("rotation"),
            stroke: p.get("stroke"),
          };
        }).concat(graphics.map(function(g) {
          return {
            type: "graphic",
            id: g.id,
            layer: g.get("layer"),
            left: g.get("left"),
            top: g.get("top"),
            width: g.get("width"),
            height: g.get("height"),
            rotation: g.get("rotation"),
            imgsrc: g.get("imgsrc"),
          };
        }));
        writeResult(nonce, results);
        break;
      }

      case "getDoors": {
        // door/window objects use pageid (not _pageid) and inverted y-axis.
        // y values from Roll20 are negative; negate them to get normal page coords.
        function mapOpening(obj, type) {
          let path = obj.get("path") || {};
          let h0 = path.handle0 || {};
          let h1 = path.handle1 || {};
          return {
            id: obj.id,
            type: type,
            x: obj.get("x"),
            y: -(obj.get("y")),
            handle0: { x: h0.x, y: h0.y !== undefined ? -(h0.y) : undefined },
            handle1: { x: h1.x, y: h1.y !== undefined ? -(h1.y) : undefined },
            color: obj.get("color"),
            isOpen: obj.get("isOpen"),
            isLocked: obj.get("isLocked"),
            isSecret: obj.get("isSecret"),
          };
        }
        let doors = findObjs({ _type: "door", pageid: args.pageId });
        let windows = findObjs({ _type: "window", pageid: args.pageId });
        writeResult(nonce, {
          doors: doors.map(function(d) { return mapOpening(d, "door"); }),
          windows: windows.map(function(w) { return mapOpening(w, "window"); }),
        });
        break;
      }

      case "clearLayer": {
        // Remove all path/graphic objects from the specified layer on a page.
        // Also clears UDL wall objects when the "walls" layer is targeted.
        const page = getObj("page", args.pageId);
        if (!page) throw new Error(`Page not found: ${args.pageId}`);
        const layers = args.layers || [args.layer || "walls"];
        let removed = 0;
        layers.forEach(function(layer) {
          findObjs({ _type: "path", _pageid: args.pageId, layer: layer }).forEach(function(obj) {
            obj.remove();
            removed++;
          });
          findObjs({ _type: "graphic", _pageid: args.pageId, layer: layer }).forEach(function(obj) {
            obj.remove();
            removed++;
          });
          if (layer === "walls") {
            // Remove pathv2 DL barriers (Latest VTT Engine) and legacy wall objects.
            findObjs({ _type: "pathv2", _pageid: args.pageId, layer: "walls" }).forEach(function(obj) {
              obj.remove();
              removed++;
            });
            findObjs({ _type: "wall", _pageid: args.pageId }).forEach(function(obj) {
              obj.remove();
              removed++;
            });
            findObjs({ _type: "wall", pageid: args.pageId }).forEach(function(obj) {
              obj.remove();
              removed++;
            });
          }
        });
        writeResult(nonce, { removed: removed });
        break;
      }

      case "drawLayerTest": {
        // Draw one diagonal line per layer using legacy path objects to identify which layers Roll20's UI shows.
        // Coordinates use top-left-relative convention (UVTT importer style):
        // path points are relative to bounding box min corner, always positive.
        // left/top = center of bounding box = minX+width/2, minY+height/2.
        let layerTests = [
          { layer: "map",        stroke: "#FF0000", path: '[["M",0,0],["L",2170,2940]]',    left: 1085, top: 1470, width: 2170, height: 2940 },
          { layer: "objects",    stroke: "#00FF00", path: '[["M",2170,0],["L",0,2940]]',    left: 1085, top: 1470, width: 2170, height: 2940 },
          { layer: "foreground", stroke: "#FF00FF", path: '[["M",0,0],["L",2170,0]]',       left: 1085, top:  980, width: 2170, height: 0 },
          { layer: "gmlayer",    stroke: "#0000FF", path: '[["M",0,0],["L",2170,0]]',       left: 1085, top: 1470, width: 2170, height: 0 },
          { layer: "walls",      stroke: "#FF8800", path: '[["M",0,0],["L",0,2940]]',       left: 1085, top: 1470, width: 0,    height: 2940 },
        ];
        let results = layerTests.map(function(t) {
          let obj = createObj("path", {
            pageid: args.pageId,
            layer: t.layer,
            path: t.path,
            stroke: t.stroke,
            stroke_width: 10,
            fill: "transparent",
            left: t.left,
            top: t.top,
            width: t.width,
            height: t.height,
            rotation: 0,
            scaleX: 1,
            scaleY: 1,
            controlledby: senderPlayerId,
          });
          return { layer: t.layer, stroke: t.stroke, id: obj ? obj.id : null };
        });
        writeResult(nonce, results);
        break;
      }

      case "runUVTT": {
        // Create a carrier graphic on gmlayer with UVTT JSON in its gmnotes,
        // then trigger the UniversalVTTImporter mod via !uvtt --ids.
        let uvttGraphic = createObj("graphic", {
          _pageid: args.pageId,
          layer: "gmlayer",
          name: "uvtt-data-carrier",
          left: 35,
          top: 35,
          width: 70,
          height: 70,
          controlledby: "",
          showname: false,
        });
        if (!uvttGraphic) throw new Error("Failed to create carrier graphic for UVTT import");

        let uvttJson = typeof args.uvttData === "string"
          ? args.uvttData
          : JSON.stringify(args.uvttData);
        uvttGraphic.set("gmnotes", uvttJson);

        let extraArgs = args.noObjects ? " --no-objects" : "";
        let uvttCmd = "!uvtt --ids " + uvttGraphic.id + extraArgs;
        sendChat("API", uvttCmd);

        writeResult(nonce, {
          graphicId: uvttGraphic.id,
          command: uvttCmd,
          note: "UVTT import triggered. Delete graphicId when done.",
        });
        break;
      }

      case "createPolylines": {
        // Create one path object per polyline from an ordered list of absolute-pixel points.
        // Each polyline: { points: [[x,y], ...], stroke?, stroke_width?, closed?, layer? }
        let polylineResults = (args.polylines || []).map(function(pl) {
          let pts = pl.points || [];
          if (pts.length < 2) return { error: "Need at least 2 points" };
          let minX = Math.min.apply(null, pts.map(function(p) { return p[0]; }));
          let minY = Math.min.apply(null, pts.map(function(p) { return p[1]; }));
          let maxX = Math.max.apply(null, pts.map(function(p) { return p[0]; }));
          let maxY = Math.max.apply(null, pts.map(function(p) { return p[1]; }));
          let pathCmds = pts.map(function(p, i) {
            return [i === 0 ? "M" : "L", p[0] - minX, p[1] - minY];
          });
          if (pl.closed) pathCmds.push(["Z"]);
          let pathObj = createObj("path", {
            pageid: args.pageId,
            layer: pl.layer || args.layer || "walls",
            path: JSON.stringify(pathCmds),
            left: (minX + maxX) / 2,
            top: (minY + maxY) / 2,
            width: Math.max(maxX - minX, 1),
            height: Math.max(maxY - minY, 1),
            stroke: pl.stroke || args.stroke || "#FFFF00",
            stroke_width: pl.stroke_width || args.stroke_width || 5,
            fill: pl.fill || args.fill || "transparent",
            rotation: 0,
            scaleX: 1,
            scaleY: 1,
            controlledby: "",
          });
          return pathObj ? { id: pathObj.id, pointCount: pts.length } : { error: "createObj('path') returned undefined" };
        });
        writeResult(nonce, polylineResults);
        break;
      }

      case "clearDLOpenings": {
        // Remove all native door and window DL objects from a page.
        let removed = 0;
        findObjs({ _type: "door", pageid: args.pageId }).forEach(function(o) { o.remove(); removed++; });
        findObjs({ _type: "window", pageid: args.pageId }).forEach(function(o) { o.remove(); removed++; });
        writeResult(nonce, { removed: removed });
        break;
      }

      case "getTurnOrder": {
        let rawOrder = Campaign().get("turnorder");
        writeResult(nonce, rawOrder ? JSON.parse(rawOrder) : []);
        break;
      }

      case "setTurnOrder": {
        Campaign().set("turnorder", JSON.stringify(args.entries || []));
        writeResult(nonce, { ok: true, count: (args.entries || []).length });
        break;
      }

      case "rollInitiativeForTokens": {
        // Roll d20 + initiative bonus for each token. Tries common 5e attribute names.
        // If args.rollPublic is true, tokens with a linked character sheet get a gothic public announcement.
        // Duplicate-named tokens are renamed with a random epithet (e.g. "Goblin the Savage") so they
        // are distinguishable both on the map and in the turn tracker.
        let initAttrNames = ["initiative_bonus", "npc_initiative", "dex_mod", "dexterity_mod"];
        let rollPublic = !!args.rollPublic;

        // Pass 1: count names to detect duplicates
        let nameCounts = {};
        (args.tokenIds || []).forEach(function(tokenId) {
          let token = getObj("graphic", tokenId);
          if (!token) return;
          let n = token.get("name");
          nameCounts[n] = (nameCounts[n] || 0) + 1;
        });

        // Pass 2: rename duplicates with epithets drawn from monster-type word banks
        let usedEpithets = {};
        (args.tokenIds || []).forEach(function(tokenId) {
          let token = getObj("graphic", tokenId);
          if (!token) return;
          let baseName = token.get("name");
          if ((nameCounts[baseName] || 0) <= 1) return;
          if (!usedEpithets[baseName]) usedEpithets[baseName] = [];
          let pool = getMonsterEpithets(baseName);
          let available = pool.filter(function(e) { return usedEpithets[baseName].indexOf(e) === -1; });
          if (!available.length) available = pool;
          let chosen = available[Math.floor(Math.random() * available.length)];
          usedEpithets[baseName].push(chosen);
          token.set("name", baseName + "\nthe " + chosen);
        });

        // Pass 3: gather init bonuses (synchronous), then roll via Roll20's real dice engine
        let rollNonce = nonce;
        let tokenData = [];
        (args.tokenIds || []).forEach(function(tokenId) {
          let token = getObj("graphic", tokenId);
          if (!token) { tokenData.push({ tokenId: tokenId, error: "Token not found" }); return; }

          let initBonus = 0;
          let charId = token.get("represents");
          if (charId) {
            for (let i = 0; i < initAttrNames.length; i++) {
              let attrs = findObjs({ _type: "attribute", _characterid: charId, name: initAttrNames[i] });
              if (attrs.length > 0) {
                let val = parseInt(attrs[0].get("current"));
                if (!isNaN(val)) { initBonus = val; break; }
              }
            }
          }
          tokenData.push({ tokenId: tokenId, name: token.get("name"), initBonus: initBonus, charId: charId || "" });
        });

        let validTokens = tokenData.filter(function(t) { return !t.error; });
        if (!validTokens.length) { writeResult(rollNonce, tokenData); break; }

        // Build one inline roll expression per token: "Name: [[1d20+bonus]]"
        let msgParts = validTokens.map(function(t) {
          let sign = t.initBonus >= 0 ? "+" : "";
          return t.name + ": [[1d20" + (t.initBonus !== 0 ? sign + t.initBonus : "") + "]]";
        });

        sendChat("GM-AI-Bridge", msgParts.join(" | "), function(ops) {
          let inlinerolls = (ops && ops[0] && ops[0].inlinerolls) ? ops[0].inlinerolls : [];

          let rollResults = validTokens.map(function(t, i) {
            let roll = inlinerolls[i];
            let d20 = 1, total = 1 + t.initBonus;
            if (roll) {
              total = roll.results.total;
              // First roll group is the d20
              let firstGroup = roll.results.rolls && roll.results.rolls[0];
              if (firstGroup && firstGroup.type === "R" && firstGroup.results && firstGroup.results[0]) {
                d20 = firstGroup.results[0].v;
              } else {
                d20 = total - t.initBonus;
              }
            }
            return { tokenId: t.tokenId, name: t.name, d20: d20, initBonus: t.initBonus, total: total };
          });

          // Announce public entries via gothic HTML card
          if (rollPublic) {
            let publicEntries = rollResults.filter(function(r) {
              return validTokens.some(function(t) { return t.tokenId === r.tokenId && t.charId; });
            });
            if (publicEntries.length > 0) {
              publicEntries.sort(function(a, b) { return b.total - a.total; });
              let rows = publicEntries.map(function(e, idx) {
                let icon = idx === 0 ? "👑" : "🩸";
                let sign = e.initBonus >= 0 ? "+" : "";
                let detail = "<span style='color:#6b4040;font-size:0.82em;'> d20(" + e.d20 + ")" + sign + e.initBonus + "</span>";
                return "<tr>"
                  + "<td style='padding:3px 8px;color:#d4a0a0;font-family:Palatino Linotype,Palatino,serif;'>" + icon + " " + e.name + "</td>"
                  + "<td style='padding:3px 8px;color:#ff5555;font-weight:bold;text-align:right;font-family:Palatino Linotype,Palatino,serif;'>" + e.total + detail + "</td>"
                  + "</tr>";
              }).join("");
              let html = "<div style='background:#080204;border:1px solid #5a0000;padding:6px 10px;'>"
                + "<div style='color:#660000;text-align:center;letter-spacing:3px;font-size:0.85em;'>▾ ▼ ▾ ▼ ▾ ▼ ▾</div>"
                + "<div style='color:#cc4444;text-align:center;font-size:1.05em;margin:4px 0;font-family:Palatino Linotype,Palatino,serif;'>🪶 𝔗𝔥𝔢 𝔇𝔢𝔞𝔡'𝔰 𝔇𝔯𝔞𝔴 🪶</div>"
                + "<table style='width:100%;border-collapse:collapse;margin:4px 0;'>" + rows + "</table>"
                + "<div style='color:#4a0000;text-align:center;font-size:0.85em;margin-top:4px;'>— ✦ —</div>"
                + "</div>";
              sendChat("Initiative", "/direct " + html);
            }
          }

          writeResult(rollNonce, rollResults.concat(tokenData.filter(function(t) { return t.error; })));
        }, { noarchive: true });
        break;
      }

      case "advanceTurn": {
        let order = Campaign().get("turnorder");
        if (!order) { writeResult(nonce, { ok: false, note: "Turn order is empty" }); break; }
        let entries = JSON.parse(order);
        if (entries.length === 0) { writeResult(nonce, { ok: false, note: "Turn order is empty" }); break; }
        // Rotate: move first entry to end
        entries.push(entries.shift());
        Campaign().set("turnorder", JSON.stringify(entries));
        let current = entries[0];
        let currentToken = current.id ? getObj("graphic", current.id) : null;
        writeResult(nonce, {
          ok: true,
          current: {
            id: current.id,
            pr: current.pr,
            custom: current.custom,
            name: currentToken ? currentToken.get("name") : (current.custom || "?"),
          },
        });
        break;
      }

      case "getTokenById": {
        let token = getObj("graphic", args.tokenId);
        if (!token) { writeResult(nonce, null); break; }
        writeResult(nonce, {
          id: token.id,
          name: token.get("name"),
          represents: token.get("represents") || "",
          layer: token.get("layer"),
          controlledby: token.get("controlledby") || "",
          left: token.get("left"),
          top: token.get("top"),
          width: token.get("width"),
          height: token.get("height"),
          rotation: token.get("rotation"),
          imgsrc: token.get("imgsrc"),
          statusmarkers: token.get("statusmarkers") || "",
          bar1_value: token.get("bar1_value"),
          bar1_max: token.get("bar1_max"),
          bar2_value: token.get("bar2_value"),
          bar2_max: token.get("bar2_max"),
          bar3_value: token.get("bar3_value"),
          bar3_max: token.get("bar3_max"),
          aura1_radius: token.get("aura1_radius"),
          aura1_color: token.get("aura1_color"),
          aura1_square: token.get("aura1_square"),
          showplayers_aura1: token.get("showplayers_aura1"),
          aura2_radius: token.get("aura2_radius"),
          aura2_color: token.get("aura2_color"),
          aura2_square: token.get("aura2_square"),
          showplayers_aura2: token.get("showplayers_aura2"),
          tint_color: token.get("tint_color"),
          light_radius: token.get("light_radius"),
          light_dimradius: token.get("light_dimradius"),
          gmnotes: token.get("gmnotes") || "",
        });
        break;
      }

      case "setTokenProps": {
        let token = getObj("graphic", args.tokenId);
        if (!token) throw new Error("Token not found: " + args.tokenId);
        token.set(args.props || {});
        writeResult(nonce, { ok: true });
        break;
      }

      case "getRecentChat": {
        let n = Math.min(args.limit || 50, CHAT_BUFFER.length);
        writeResult(nonce, CHAT_BUFFER.slice(-n));
        break;
      }

      case "getDmInbox": {
        let inboxEntries = args.type
          ? DM_INBOX.filter(function(e) { return e.type === args.type; })
          : DM_INBOX.slice();
        writeResult(nonce, inboxEntries);
        break;
      }

      case "clearDmInbox": {
        if (args.playerName) {
          DM_INBOX = DM_INBOX.filter(function(e) { return e.who !== args.playerName; });
        } else {
          DM_INBOX = [];
        }
        writeResult(nonce, { ok: true });
        break;
      }

      case "setMobPlan": {
        if (!args.tokenId) throw new Error("setMobPlan requires tokenId");
        if (args.html) {
          MOB_PLANS[args.tokenId] = { html: args.html };
        } else {
          delete MOB_PLANS[args.tokenId];
        }
        writeResult(nonce, { ok: true });
        break;
      }

      case "clearMobPlans": {
        MOB_PLANS = {};
        writeResult(nonce, { ok: true });
        break;
      }

      case "whisperPlayer": {
        if (!args.playerName || !args.message) throw new Error("whisperPlayer requires playerName and message");
        sendChat("GM-AI-Bridge", "/w " + args.playerName + " " + args.message, null, { noarchive: true });
        writeResult(nonce, { ok: true });
        break;
      }

      case "findTokensInRange": {
        let centerToken = getObj("graphic", args.centerTokenId);
        if (!centerToken) throw new Error("Center token not found: " + args.centerTokenId);
        let pageId = args.pageId || centerToken.get("_pageid");
        let page = getObj("page", pageId);
        if (!page) throw new Error("Page not found: " + pageId);
        let scaleNumber = page.get("scale_number") || 5;
        let pixelsPerFoot = 70 / scaleNumber;
        let cx = centerToken.get("left");
        let cy = centerToken.get("top");
        let radiusFeet = args.radiusFeet || 15;
        let radiusPx = radiusFeet * pixelsPerFoot;
        let allTokens = findObjs({ _type: "graphic", _pageid: pageId });
        let rangeResults = [];
        allTokens.forEach(function(t) {
          if (t.id === args.centerTokenId) return;
          if (args.layerFilter && t.get("layer") !== args.layerFilter) return;
          let dx = t.get("left") - cx;
          let dy = t.get("top") - cy;
          let distPx = Math.sqrt(dx * dx + dy * dy);
          let distFeet = distPx / pixelsPerFoot;
          if (distFeet <= radiusFeet) {
            rangeResults.push({
              id: t.id,
              name: t.get("name"),
              layer: t.get("layer"),
              distanceFeet: Math.round(distFeet * 10) / 10,
              bar1_value: t.get("bar1_value"),
              bar1_max: t.get("bar1_max"),
              controlledby: t.get("controlledby") || "",
            });
          }
        });
        rangeResults.sort(function(a, b) { return a.distanceFeet - b.distanceFeet; });
        writeResult(nonce, rangeResults);
        break;
      }

      case "setTurnHook": {
        TURN_HOOK_ENABLED = !!args.enabled;
        if (args.reset) { ROUND_NUMBER = 0; ROUND_FIRST_TOKEN_ID = null; }
        writeResult(nonce, { ok: true, enabled: TURN_HOOK_ENABLED, round: ROUND_NUMBER });
        break;
      }

      case "getTurnHookState": {
        writeResult(nonce, { enabled: TURN_HOOK_ENABLED, round: ROUND_NUMBER, firstTokenId: ROUND_FIRST_TOKEN_ID });
        break;
      }

      case "setCharacterAttributes": {
        // Write attributes to a Roll20 character sheet (charId = the `represents` field from the token).
        // args.attributes values can be plain scalars (sets current only) or { current, max } objects.
        // NOTE: findObjs uses _characterid (underscore), but createObj requires characterid (no underscore).
        let charId = args.charId;
        let attributes = args.attributes || {};
        let updated = [], created = [], failed = [];
        Object.keys(attributes).forEach(function(attrName) {
          let val = attributes[attrName];
          let isObj = typeof val === "object" && val !== null;
          let currentVal = isObj ? val.current : val;
          let maxVal = isObj ? val.max : undefined;
          let existing = findObjs({ _type: "attribute", _characterid: charId, name: attrName });
          if (existing.length > 0) {
            let updates = {};
            if (currentVal !== undefined) updates.current = currentVal;
            if (maxVal !== undefined) updates.max = maxVal;
            existing[0].set(updates);
            updated.push(attrName);
          } else {
            let createArgs = { characterid: charId, name: attrName };
            if (currentVal !== undefined) createArgs.current = currentVal;
            if (maxVal !== undefined) createArgs.max = maxVal;
            let obj = createObj("attribute", createArgs);
            if (obj) { created.push(attrName); } else { failed.push(attrName); }
          }
        });
        writeResult(nonce, { updated: updated, created: created, failed: failed });
        break;
      }

      case "getCharacterAttributes": {
        // Read attributes from a Roll20 character sheet. Pass names[] to filter.
        let charId = args.charId;
        let nameFilter = args.names;
        let attrs = findObjs({ _type: "attribute", _characterid: charId });
        let result = {};
        attrs.forEach(function(a) {
          let attrName = a.get("name");
          if (!nameFilter || nameFilter.indexOf(attrName) !== -1) {
            result[attrName] = { current: a.get("current"), max: a.get("max") };
          }
        });
        writeResult(nonce, result);
        break;
      }

      case "getRepeatingSection": {
        // Returns all rows of a repeating section from a character sheet.
        // args.charId, args.section (e.g. "npcaction")
        // Result: { [rowId]: { [fieldName]: value } }
        if (!args.charId || !args.section) throw new Error("getRepeatingSection requires charId and section");
        let repAttrs = findObjs({ _type: "attribute", _characterid: args.charId });
        let prefix = "repeating_" + args.section + "_";
        let rows = {};
        repAttrs.forEach(function(a) {
          let name = a.get("name");
          if (name.indexOf(prefix) !== 0) return;
          let rest = name.slice(prefix.length);
          let sep = rest.indexOf("_");
          if (sep === -1) return;
          let rowId = rest.slice(0, sep);
          let field = rest.slice(sep + 1);
          if (!rows[rowId]) rows[rowId] = {};
          rows[rowId][field] = a.get("current");
        });
        writeResult(nonce, rows);
        break;
      }

      case "syncConditionsToToken": {
        // Set all status markers on a token and store active_conditions on the character.
        // args.tokenId, args.charId (optional), args.conditions: string[]
        let token = getObj("graphic", args.tokenId);
        if (!token) throw new Error("Token not found: " + args.tokenId);
        let activeSet = new Set((args.conditions || []).map(function(c) { return c.toLowerCase(); }));
        let markerSet = new Set((token.get("statusmarkers") || "").split(",").filter(Boolean));
        // Build set of all known marker strings in every format (Name::id, Name, name)
        // so stale plain-name versions left from prior attempts get cleaned up.
        let allKnown = new Set();
        Object.keys(CONDITION_MARKERS).forEach(function(condition) {
          let tag = CONDITION_MARKERS[condition];
          allKnown.add(tag);
          let displayName = tag.split("::")[0];
          allKnown.add(displayName);
          allKnown.add(displayName.toLowerCase());
        });
        allKnown.forEach(function(m) { markerSet.delete(m); });
        // Re-add only active conditions with correct Name::id tags
        activeSet.forEach(function(condition) {
          let marker = CONDITION_MARKERS[condition];
          if (marker) markerSet.add(marker);
        });
        token.set("statusmarkers", Array.from(markerSet).join(","));
        if (args.charId) setConditionAttr(args.charId, activeSet);
        writeResult(nonce, { ok: true, conditions: Array.from(activeSet), markers: Array.from(markerSet) });
        break;
      }

      case "toggleCondition": {
        // Toggle a single condition on a token sticker and character attribute.
        // args.tokenId, args.charId (optional), args.condition: string, args.active: boolean
        let token = getObj("graphic", args.tokenId);
        if (!token) throw new Error("Token not found: " + args.tokenId);
        let condition = (args.condition || "").toLowerCase();
        let marker = CONDITION_MARKERS[condition] || condition;
        let markerSet = new Set((token.get("statusmarkers") || "").split(",").filter(Boolean));
        if (args.active) markerSet.add(marker); else markerSet.delete(marker);
        token.set("statusmarkers", Array.from(markerSet).join(","));
        if (args.charId) {
          let existing = findObjs({ _type: "attribute", _characterid: args.charId, name: "active_conditions" });
          let condList = existing.length > 0 ? (existing[0].get("current") || "").split(",").filter(Boolean) : [];
          let condSet = new Set(condList);
          if (args.active) condSet.add(condition); else condSet.delete(condition);
          setConditionAttr(args.charId, condSet);
        }
        writeResult(nonce, { ok: true, condition: condition, active: !!args.active, marker: marker });
        break;
      }

      case "getTokenMarkers": {
        let raw = Campaign().get("token_markers");
        let markers = typeof raw === "string" ? JSON.parse(raw) : (raw || []);
        writeResult(nonce, markers.map(function(m) {
          return { id: m.id, name: m.name, tag: m.tag };
        }));
        break;
      }

      case "rollFormulas": {
        // Roll one or more dice formulas using Roll20's real dice engine via sendChat inline rolls.
        // Each item: { label, formula }  e.g. { label: "Fireball save — Goblin", formula: "1d20+2" }
        // Results appear in Roll20 chat (noarchive by default so they don't clutter the log).
        let rollNonce = nonce;
        let items = args.items || [];
        if (!items.length) { writeResult(rollNonce, []); break; }

        let speaker = args.speakAs || "GM-AI-Bridge";
        let noarchive = args.silent === true; // default visible; pass silent:true to hide from chat
        let msgParts = items.map(function(item) {
          return (item.label ? item.label + ": " : "") + "[[" + item.formula + "]]";
        });

        sendChat(speaker, msgParts.join(" | "), function(ops) {
          let inlinerolls = (ops && ops[0] && ops[0].inlinerolls) ? ops[0].inlinerolls : [];
          let results = items.map(function(item, i) {
            let roll = inlinerolls[i];
            if (!roll) return { label: item.label || "", formula: item.formula, total: 0, dice: [], error: "no roll" };
            let dice = [];
            (roll.results.rolls || []).forEach(function(r) {
              if (r.type === "R") (r.results || []).forEach(function(d) { dice.push(d.v); });
            });
            return {
              label: item.label || "",
              formula: item.formula,
              total: roll.results.total,
              dice: dice,
            };
          });
          writeResult(rollNonce, results);
        }, { noarchive: noarchive });
        break;
      }

      case "sendNarration": {
        // Send styled narrative text to Roll20 chat, visible to all players.
        // style: "narration" (default) | "combat" | "dramatic" | "ambient"
        let narText = args.text || "";
        let narStyle = args.style || "narration";
        let narSpeaker = args.speakAs || "The Dark Powers";

        let styles = {
          narration: "font-family:Georgia,serif;font-style:italic;color:#e8c97e;border:1px solid #7a3030;border-left-width:3px;padding:7px 12px;background:#1c0808;line-height:1.65;border-radius:2px;",
          combat:    "font-family:Georgia,serif;font-weight:bold;color:#f08080;border:1px solid #8b0000;border-left-width:3px;padding:7px 12px;background:#200a0a;line-height:1.65;border-radius:2px;",
          dramatic:  "font-family:Georgia,serif;font-weight:bold;font-style:italic;color:#e8c040;text-align:center;border:1px solid #8b6914;border-top-width:2px;border-bottom-width:2px;padding:10px 14px;background:#1a1100;letter-spacing:0.5px;line-height:1.7;border-radius:2px;",
          ambient:   "font-family:Georgia,serif;font-style:italic;color:#a8c890;border:1px solid #4a6a3a;border-left-width:3px;padding:7px 12px;background:#080f08;line-height:1.65;border-radius:2px;",
        };
        let styleStr = styles[narStyle] || styles.narration;
        let html = "<div style='" + styleStr + "'>" + narText + "</div>";
        sendChat(narSpeaker, html, null, {});
        writeResult(nonce, { ok: true });
        break;
      }

      case "batchExec": {
        // Execute N sync operations in a single relay round-trip.
        // Each op: { id?, action, args? }
        // Returns: [{ id, ok, data?, error? }]
        let batchOps = args.ops || [];
        let batchResults = [];
        batchOps.forEach(function(op) {
          let opId = (op.id != null) ? op.id : batchResults.length;
          try {
            let data = runBatchOp(op.action, op.args || {});
            batchResults.push({ id: opId, ok: true, data: data });
          } catch(e) {
            batchResults.push({ id: opId, ok: false, error: String(e) });
          }
        });
        writeResult(nonce, batchResults);
        break;
      }

      case "ping": {
        writeResult(nonce, { pong: true, version: "2.0.0" });
        break;
      }

      case "createZone": {
        // Draw a named zone (circle or rect) on the "objects" layer.
        // Metadata stored in gmnotes so it survives relay restarts.
        // centerX/centerY in page pixels; radiusFeet converted via page scale.
        let zonePage = getObj("page", args.pageId);
        if (!zonePage) throw new Error("Page not found: " + args.pageId);
        let zoneScale = args.scaleNumber || zonePage.get("scale_number") || 5;
        let zoneRadiusPx = (args.radiusFeet || 15) * (70 / zoneScale);
        let zoneCx = args.centerX || 0;
        let zoneCy = args.centerY || 0;
        let zoneColor = args.color || "#aa00ff";
        let zoneName = "ZONE: " + (args.name || "Zone");

        let zonePath, zoneWidth, zoneHeight;
        if ((args.shape || "circle") === "rect") {
          // Rectangle: width/height passed directly in feet, converted to pixels
          let halfW = (args.widthFeet || args.radiusFeet || 15) * (70 / zoneScale) / 2;
          let halfH = (args.heightFeet || args.radiusFeet || 15) * (70 / zoneScale) / 2;
          zoneWidth = halfW * 2;
          zoneHeight = halfH * 2;
          zonePath = JSON.stringify([["M",0,0],["L",zoneWidth,0],["L",zoneWidth,zoneHeight],["L",0,zoneHeight],["Z"]]);
        } else {
          zonePath = makeCirclePath(zoneRadiusPx);
          zoneWidth = zoneRadiusPx * 2;
          zoneHeight = zoneRadiusPx * 2;
        }

        let zoneObj = createObj("path", {
          pageid: args.pageId,
          layer: "map",
          path: zonePath,
          left: zoneCx,
          top: zoneCy,
          width: zoneWidth,
          height: zoneHeight,
          rotation: 0,
          stroke: zoneColor,
          stroke_width: 3,
          fill: zoneColor,
          fill_opacity: 0.25,
          scaleX: 1,
          scaleY: 1,
          controlledby: "",
        });
        if (!zoneObj) throw new Error("Failed to create zone path object");
        zoneObj.set("name", zoneName);
        zoneObj.set("gmnotes", JSON.stringify({
          zone: true,
          name: args.name || "Zone",
          shape: args.shape || "circle",
          centerX: zoneCx,
          centerY: zoneCy,
          radiusFeet: args.radiusFeet || 15,
          color: zoneColor,
        }));
        writeResult(nonce, { id: zoneObj.id, name: zoneName, radiusFeet: args.radiusFeet || 15, centerX: zoneCx, centerY: zoneCy });
        break;
      }

      case "clearZone": {
        if (args.zoneId) {
          let zo = getObj("path", args.zoneId);
          if (zo) zo.remove();
          writeResult(nonce, { removed: zo ? 1 : 0 });
        } else if (args.name) {
          let prefix = "ZONE: " + args.name;
          let found = findObjs({ _type: "path", _pageid: args.pageId }).filter(function(p) {
            return p.get("name") === prefix;
          });
          found.forEach(function(p) { p.remove(); });
          writeResult(nonce, { removed: found.length });
        } else {
          throw new Error("clearZone requires zoneId or name");
        }
        break;
      }

      case "removeObject": {
        // Remove any Roll20 object by id. Tries graphic, then path.
        let roObj = getObj(args.objectType || "graphic", args.objectId);
        if (!roObj && (!args.objectType || args.objectType === "graphic")) roObj = getObj("path", args.objectId);
        if (!roObj) throw new Error("Object not found: " + args.objectId);
        roObj.remove();
        writeResult(nonce, { ok: true, id: args.objectId });
        break;
      }

      case "listZones": {
        let allPaths = findObjs({ _type: "path", _pageid: args.pageId });
        let zones = allPaths.filter(function(p) {
          return (p.get("name") || "").startsWith("ZONE: ");
        }).map(function(p) {
          let meta = {};
          try { meta = JSON.parse(p.get("gmnotes") || "{}"); } catch(e) {}
          return {
            id: p.id,
            name: p.get("name"),
            left: p.get("left"),
            top: p.get("top"),
            meta: meta,
          };
        });
        writeResult(nonce, zones);
        break;
      }

      case "findTokensInZone": {
        // Load zone metadata from gmnotes, then check all tokens for containment.
        let zoneGraphic = getObj("path", args.zoneId);
        if (!zoneGraphic) throw new Error("Zone not found: " + args.zoneId);
        let zoneMeta = {};
        try { zoneMeta = JSON.parse(zoneGraphic.get("gmnotes") || "{}"); } catch(e) {}
        let zCx = zoneMeta.centerX != null ? zoneMeta.centerX : zoneGraphic.get("left");
        let zCy = zoneMeta.centerY != null ? zoneMeta.centerY : zoneGraphic.get("top");
        let zRadFeet = zoneMeta.radiusFeet || 15;
        let zPage = getObj("page", args.pageId || zoneGraphic.get("_pageid"));
        if (!zPage) throw new Error("Page not found");
        let zScale = zPage.get("scale_number") || 5;
        let zPxPerFoot = 70 / zScale;
        let zRadPx = zRadFeet * zPxPerFoot;
        let zTokens = findObjs({ _type: "graphic", _pageid: zPage.id });
        let inZone = [];
        zTokens.forEach(function(t) {
          let dx = t.get("left") - zCx;
          let dy = t.get("top") - zCy;
          let distPx = Math.sqrt(dx * dx + dy * dy);
          if (distPx <= zRadPx) {
            inZone.push({
              id: t.id,
              name: t.get("name"),
              layer: t.get("layer"),
              distanceFeet: Math.round((distPx / zPxPerFoot) * 10) / 10,
              bar1_value: t.get("bar1_value"),
              bar1_max: t.get("bar1_max"),
            });
          }
        });
        inZone.sort(function(a, b) { return a.distanceFeet - b.distanceFeet; });
        writeResult(nonce, inZone);
        break;
      }

      default:
        throw new Error(`Unknown action: ${action}`);
    }
  } catch (err) {
    writeResult(nonce, null, err.message || String(err));
  }
});

// Build a reverse map from marker tag → condition name (for statusmarkers → condition names).
function buildMarkerToCondition() {
  let map = {};
  Object.keys(CONDITION_MARKERS).forEach(function(cond) {
    map[CONDITION_MARKERS[cond]] = cond;
  });
  return map;
}

// Read combatant status for a turn order entry. Returns a display string.
function combatantStatusLine(entry) {
  if (!entry || !entry.id) return null;
  let t = getObj("graphic", entry.id);
  if (!t) return null;
  let name = t.get("name") || "?";
  let hp = t.get("bar1_value");
  let maxHp = t.get("bar1_max");
  let markerMap = buildMarkerToCondition();
  let markers = (t.get("statusmarkers") || "").split(",").filter(Boolean);
  let conditions = markers.map(function(m) { return markerMap[m]; }).filter(Boolean);
  // De-duplicate (dead/unconscious share a marker)
  let condSet = {};
  conditions.forEach(function(c) { condSet[c] = true; });
  let condStr = Object.keys(condSet).join(", ") || "—";
  let bar = "";
  if (maxHp) {
    let filled = Math.round((hp / maxHp) * 10);
    bar = "█".repeat(Math.max(0, filled)) + "░".repeat(Math.max(0, 10 - filled)) + " ";
  }
  return "<b>" + name + "</b> " + bar + "— " + condStr;
}

on("change:campaign:turnorder", function(obj, prev) {
  if (!TURN_HOOK_ENABLED) return;

  let rawNew = obj.get("turnorder");
  let rawOld = prev ? prev["turnorder"] : null;
  if (!rawNew) return;

  let newOrder;
  try { newOrder = JSON.parse(rawNew); } catch(e) { return; }
  if (!newOrder || newOrder.length === 0) return;

  let newFirst = newOrder[0];
  if (!newFirst || !newFirst.id) return;

  // Detect actual turn advancement (first entry changed)
  let oldFirstId = null;
  if (rawOld) {
    try { let oldOrder = JSON.parse(rawOld); oldFirstId = (oldOrder[0] || {}).id || null; } catch(e) {}
  }
  if (oldFirstId === newFirst.id) return;

  // Track round start token
  if (!ROUND_FIRST_TOKEN_ID) {
    ROUND_FIRST_TOKEN_ID = newFirst.id;
    ROUND_NUMBER = 1;
  } else if (newFirst.id === ROUND_FIRST_TOKEN_ID) {
    // Cycled back — end of round, post summary then increment
    let summaryLines = newOrder.map(function(e) { return combatantStatusLine(e); }).filter(Boolean);
    let summaryHtml = "<div style='background:#080204;border:1px solid #3a0000;padding:6px 10px;'>"
      + "<div style='color:#cc4444;font-family:\"Palatino Linotype\",Palatino,serif;text-align:center;font-size:1em;margin-bottom:4px;'>⚔ Round " + ROUND_NUMBER + " Complete</div>"
      + summaryLines.map(function(r) {
          return "<div style='color:#d4a0a0;font-family:\"Palatino Linotype\",Palatino,serif;font-size:0.9em;padding:1px 4px;'>" + r + "</div>";
        }).join("")
      + "</div>";
    sendChat("GM-AI-Bridge", summaryHtml, null, { noarchive: false });
    ROUND_NUMBER++;
  }

  // Post turn announcement
  let token = getObj("graphic", newFirst.id);
  let name = token ? token.get("name") : (newFirst.custom || "?");
  let hp = token ? token.get("bar1_value") : null;
  let maxHp = token ? token.get("bar1_max") : null;
  let markerMap = buildMarkerToCondition();
  let markers = token ? (token.get("statusmarkers") || "").split(",").filter(Boolean) : [];
  let condSet = {};
  markers.forEach(function(m) { let c = markerMap[m]; if (c) condSet[c] = true; });
  let conditions = Object.keys(condSet);

  // Check DM_INBOX for a preloaded intent from this token's controller
  let pendingIntent = null;
  if (token) {
    let controlled = token.get("controlledby") || "";
    let controllerIds = controlled.split(",").map(function(s){ return s.trim(); }).filter(Boolean);
    for (let di = 0; di < DM_INBOX.length; di++) {
      if (DM_INBOX[di].type === "intent" && controllerIds.indexOf(DM_INBOX[di].playerid) !== -1) {
        pendingIntent = DM_INBOX[di];
        DM_INBOX.splice(di, 1);
        break;
      }
    }
  }

  // Consume any stored mob tactical plan for this token
  let mobPlan = MOB_PLANS[newFirst.id] || null;
  if (mobPlan) { delete MOB_PLANS[newFirst.id]; }

  let hpLine = "";
  if (maxHp) {
    let filled = Math.round((hp / maxHp) * 10);
    let bar = "█".repeat(Math.max(0, filled)) + "░".repeat(Math.max(0, 10 - filled));
    hpLine = "<div style='color:#d4a0a0;font-size:0.85em;font-family:monospace;'>" + bar + "</div>";
  }
  let condLine = conditions.length > 0
    ? "<div style='color:#bb8888;font-size:0.85em;'>Conditions: " + conditions.join(", ") + "</div>"
    : "";
  let intentLine = pendingIntent
    ? "<div style='color:#aaddaa;font-size:0.85em;margin-top:4px;'>📋 " + pendingIntent.who + " intends: " + pendingIntent.content + "</div>"
    : "";

  let html = "<div style='background:#080204;border-left:3px solid #cc4444;padding:5px 10px;'>"
    + "<div style='color:#cc4444;font-family:\"Palatino Linotype\",Palatino,serif;font-size:1em;'>🩸 <b>" + name + "</b> — Round " + ROUND_NUMBER + "</div>"
    + hpLine + condLine + intentLine
    + "</div>";
  sendChat("Initiative", html, null, { noarchive: false });

  if (mobPlan) {
    sendChat("GM-AI-Bridge", "/w gm " + mobPlan.html, null, { noarchive: true });
  }
});

log("[GM_AI_Bridge] Relay script loaded. Ready for !ai-relay commands.");
