import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFileSync, statSync } from "fs";
import path from "path";
import * as roll20 from "../bridge/roll20.js";
import { rtCreatePage } from "../bridge/roll20-rt.js";
import { createPin, deletePin, listPins, toPinFields, updatePin } from "../bridge/pins.js";

// --- Local-asset confinement ---------------------------------------------------
// import_map_file / upload_and_place_map_image read arbitrary local paths handed
// to them by an MCP client. Confine reads to a single asset base dir, cap size,
// and require an image extension so the tool can't be coaxed into exfiltrating
// e.g. ~/.ssh/id_rsa or a multi-GB file as base64.
export const ASSET_BASE = path.resolve(process.env.ROLL20_ASSET_DIR || path.join(process.cwd(), "data", "maps"));
const MAX_IMAGE_BYTES = 32 * 1024 * 1024; // 32 MB
const IMAGE_EXT_MEDIA: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

// Resolve `inputPath` and ensure it stays inside ASSET_BASE, is an allowed image
// type, and is within the size cap. Returns the absolute path + media type, or
// throws a clear error on any violation.
export function resolveConfinedImage(inputPath: string): { abs: string; mediaType: string; size: number } {
  const abs = path.resolve(ASSET_BASE, inputPath);
  if (abs !== ASSET_BASE && !abs.startsWith(ASSET_BASE + path.sep)) {
    throw new Error(`Path escapes the asset directory (${ASSET_BASE}): ${inputPath}`);
  }
  const ext = path.extname(abs).toLowerCase();
  const mediaType = IMAGE_EXT_MEDIA[ext];
  if (!mediaType) {
    throw new Error(`Unsupported image type "${ext || "(none)"}". Allowed: ${Object.keys(IMAGE_EXT_MEDIA).join(", ")}`);
  }
  let st;
  try {
    st = statSync(abs);
  } catch {
    throw new Error(`File not found under asset directory: ${abs}`);
  }
  if (!st.isFile()) throw new Error(`Not a regular file: ${abs}`);
  if (st.size > MAX_IMAGE_BYTES) {
    throw new Error(`File too large (${st.size} bytes > ${MAX_IMAGE_BYTES} cap): ${abs}`);
  }
  return { abs, mediaType, size: st.size };
}

export function registerMapTools(server: McpServer): void {
  server.tool(
    "setup_roll20_page",
    "Find or create a Roll20 page by name, then configure it (dimensions, scale). Creates the page automatically if it does not exist.",
    {
      name: z.string(),
      widthSquares: z.number().int().positive().default(30),
      heightSquares: z.number().int().positive().default(20),
      scaleNumber: z.number().positive().default(5),
      scaleUnits: z.enum(["ft", "m"]).default("ft"),
    },
    async ({ name, widthSquares, heightSquares, scaleNumber, scaleUnits }) => {
      const pages = await roll20.relayCommand<{ id: string; name: string; width: number; height: number }[]>({
        action: "listPages",
      });

      let page = pages.find((p) => p.name.toLowerCase() === name.toLowerCase());
      let created = false;

      if (!page) {
        // Browserless (#178): RTDB creates the page, then setPageProps below fills in the fields
        // the RTDB page does not carry (scale_number/scale_units/showgrid).
        const newId = await rtCreatePage({ name, widthSquares, heightSquares });
        page = { id: newId, name, width: widthSquares, height: heightSquares };
        created = true;
      }

      await roll20.relayCommand({
        action: "setPageProps",
        pageId: page.id,
        width: widthSquares,
        height: heightSquares,
        scale_number: scaleNumber,
        scale_units: scaleUnits,
        showgrid: true,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              pageId: page.id,
              name: page.name,
              widthSquares,
              heightSquares,
              scale: `${scaleNumber}${scaleUnits}`,
              created,
              note: `Page ${created ? "created" : "found and configured"}. Pass pageId "${page.id}" to auto_place_dl_walls and decorate_openings.`,
            }),
          },
        ],
      };
    }
  );

  server.tool(
    "upload_and_place_map_image",
    "Upload a local image file to Roll20's art library, then place it as a full-page graphic on the map layer. Handles the entire flow — no manual upload needed.",
    {
      pageId: z.string(),
      imagePath: z.string().describe("Local path to the image file, e.g. data/maps/Barovian Mansion House 2.jpg"),
      widthSquares: z.number().int().positive().default(19),
      heightSquares: z.number().int().positive().default(13),
    },
    async ({ pageId, imagePath, widthSquares, heightSquares }) => {
      const { abs } = resolveConfinedImage(imagePath);
      const imgsrc = await roll20.uploadArt(abs);

      const CELL = 70;
      const w = widthSquares * CELL;
      const h = heightSquares * CELL;
      const result = await roll20.relayCommand<{ id: string }>({
        action: "createGraphic",
        pageId,
        imgsrc,
        layer: "map",
        left: w / 2,
        top: h / 2,
        width: w,
        height: h,
      });
      return {
        content: [{ type: "text", text: JSON.stringify({ graphicId: result.id, imgsrc, widthSquares, heightSquares }) }],
      };
    }
  );

  server.tool(
    "place_map_image",
    "Place an image as a full-page graphic on the Roll20 map layer. The image must already be uploaded to Roll20's art library — paste the URL from there. Sized to fill the page exactly.",
    {
      pageId: z.string(),
      imgsrc: z.string().describe("Roll20 art library URL for the image (from Art Library → upload → copy URL)"),
      widthSquares: z.number().int().positive().default(19),
      heightSquares: z.number().int().positive().default(13),
    },
    async ({ pageId, imgsrc, widthSquares, heightSquares }) => {
      const CELL = 70;
      const w = widthSquares * CELL;
      const h = heightSquares * CELL;
      const result = await roll20.relayCommand<{ id: string }>({
        action: "createGraphic",
        pageId,
        imgsrc,
        layer: "map",
        left: w / 2,
        top: h / 2,
        width: w,
        height: h,
      });
      return {
        content: [{ type: "text", text: `Map image placed (id: ${result.id}), ${widthSquares}×${heightSquares} squares.` }],
      };
    }
  );

  server.tool(
    "import_map_file",
    "Read a local image file and return its base64 representation for use as a Roll20 page background (Roll20 requires an uploaded URL — this returns the data for you to upload manually or via the Roll20 library)",
    {
      imagePath: z.string(),
    },
    async ({ imagePath }) => {
      const { abs, mediaType } = resolveConfinedImage(imagePath);
      const buffer = readFileSync(abs);
      const base64 = buffer.toString("base64");
      const dataUrl = `data:${mediaType};base64,${base64}`;

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              imagePath: abs,
              mediaType,
              sizeBytes: buffer.length,
              dataUrl,
            }),
          },
        ],
      };
    }
  );

  server.tool(
    "search_battlemap",
    "Search for a battlemap image via web search (returns URLs to review before importing)",
    {
      query: z.string().describe("Scene description, e.g. 'forest clearing dungeon entrance'"),
      count: z.number().int().min(1).max(10).default(5),
    },
    async ({ query, count }) => {
      // WebSearch is not available as a direct import here — this tool signals
      // Claude to run a web search externally and pass the URL to import_map_file.
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              instruction: "Run a web search for battlemap images, then pass the best URL to import_map_file.",
              suggestedSites: [
                "2minutetabletop.com",
                "forgotten-adventures.net",
                "www.drivethrurpg.com",
              ],
              query: `${query} battlemap site:2minutetabletop.com OR site:forgotten-adventures.net`,
              count,
            }),
          },
        ],
      };
    }
  );

  server.tool(
    "get_doors",
    "Read back Roll20 native DL door/window objects from a page.",
    {
      pageId: z.string(),
    },
    async ({ pageId }) => {
      const result = await roll20.relayCommand<object[]>({ action: "getDoors", pageId });
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    }
  );

  server.tool(
    "get_paths",
    "Read back all path/graphic objects from a Roll20 page layer. Omit layer to get all layers at once. Use after manual edits to inspect positions.",
    {
      pageId: z.string(),
      layer: z.string().optional().describe("Layer name, e.g. 'walls', 'map', 'tokens', 'gmlayer', 'lighting'. Omit to return all layers."),
      includeGraphics: z.boolean().default(false).describe("Also return graphic objects (tokens/images) in addition to paths."),
    },
    async ({ pageId, layer, includeGraphics }) => {
      const result = await roll20.relayCommand<object[]>({
        action: "getPaths",
        pageId,
        ...(layer ? { layer } : {}),
        includeGraphics,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    }
  );

  server.tool(
    "get_map_graphics",
    "Read all graphic objects on a Roll20 page. Map-layer graphics include imgsrc for cloning pages.",
    { pageId: z.string() },
    async ({ pageId }) => {
      const result = await roll20.relayCommand({ action: "getTokens", pageId });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );

  server.tool(
    "get_walls",
    "Read UDL wall objects (Updated Dynamic Lighting) from a Roll20 page. Returns each wall's id and path coordinates.",
    {
      pageId: z.string(),
      includePoints: z.boolean().optional().describe("If true, include absolute page-pixel coordinates for each wall's vertices"),
    },
    async ({ pageId, includePoints }) => {
      const result = await roll20.relayCommand<{ id: string; path: string }[]>({
        action: "getWalls",
        pageId,
        ...(includePoints ? { includePoints: true } : {}),
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    }
  );

  server.tool(
    "draw_layer_test",
    "Draw one diagonal line per Roll20 layer using pathv2 objects, each a different color. Used to identify which layers are visible in the UI.",
    {
      pageId: z.string(),
      barrierType: z.enum(["wall", "oneWay", "transparent"]).default("transparent"),
    },
    async ({ pageId, barrierType }) => {
      const result = await roll20.relayCommand<{ layer: string; stroke: string; id: string | null }[]>({
        action: "drawLayerTest",
        pageId,
        barrierType,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "debug_page",
    "Enumerate all object types on a Roll20 page. Useful for diagnosing what layer/type UDL walls are stored as.",
    { pageId: z.string() },
    async ({ pageId }) => {
      const result = await roll20.relayCommand<object>({
        action: "debugPage",
        pageId,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "run_uvtt_import",
    "Drive the UniversalVTTImporter mod to place DL walls. Builds a UVTT JSON payload, stores it in a carrier graphic's GM notes, then sends !uvtt --ids to trigger the importer. Requires UniversalVTTImporter to be installed and active in the campaign.",
    {
      pageId: z.string(),
      walls: z.array(z.object({
        x1: z.number(), y1: z.number(),
        x2: z.number(), y2: z.number(),
      })).describe("Wall segments in Roll20 canvas pixels (70px per grid square)"),
      mapWidthSquares: z.number().int().positive().default(31),
      mapHeightSquares: z.number().int().positive().default(42),
      noObjects: z.boolean().default(false),
    },
    async ({ pageId, walls, mapWidthSquares, mapHeightSquares, noObjects }) => {
      const CELL = 70;
      const uvttData = {
        format: 0.3,
        resolution: {
          map_origin: { x: 0, y: 0 },
          map_size: { x: mapWidthSquares, y: mapHeightSquares },
          pixels_per_grid: CELL,
        },
        line_of_sight: walls.map((w) => [
          { x: w.x1, y: w.y1 },
          { x: w.x2, y: w.y2 },
        ]),
        objects_line_of_sight: [],
        portals: [],
        lights: [],
        environment: { baked_lighting: false, ambient_light: "" },
      };

      const result = await roll20.relayCommand<{ graphicId: string; command: string; note: string }>({
        action: "runUVTT",
        pageId,
        uvttData,
        noObjects,
      });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ ...result, wallCount: walls.length }),
        }],
      };
    }
  );

  server.tool(
    "clear_layer",
    "Remove all paths and graphics from one or more Roll20 layers on a page. Use before re-placing DL walls to avoid stacking.",
    {
      pageId: z.string(),
      layers: z.array(z.enum(["walls", "map", "tokens", "gmlayer", "lighting"])).default(["walls"]),
    },
    async ({ pageId, layers }) => {
      const result = await roll20.relayCommand<{ removed: number }>({
        action: "clearLayer",
        pageId,
        layers,
      });
      return {
        content: [{ type: "text", text: JSON.stringify({ removed: result.removed, layers, pageId }) }],
      };
    }
  );

  server.tool(
    "list_pages",
    "List all Roll20 pages in the campaign with their IDs, names, and dimensions.",
    {},
    async () => {
      const pages = await roll20.relayCommand<{ id: string; name: string; width: number; height: number }[]>({ action: "listPages" });
      return { content: [{ type: "text", text: JSON.stringify(pages) }] };
    }
  );

  server.tool(
    "get_current_page",
    "Return the Roll20 page ID and name that players are currently on (the player page).",
    {},
    async () => {
      const pageId = await roll20.getCurrentPageId();
      const pages = await roll20.relayCommand<{ id: string; name: string; width: number; height: number }[]>({ action: "listPages" });
      const page = pages.find((p) => p.id === pageId);
      return {
        content: [{ type: "text", text: JSON.stringify({ pageId, name: page?.name ?? "unknown", width: page?.width, height: page?.height }) }],
      };
    }
  );

  server.tool(
    "rename_roll20_page",
    "Rename an existing Roll20 page by its ID.",
    {
      pageId: z.string(),
      name: z.string(),
    },
    async ({ pageId, name }) => {
      await roll20.relayCommand({ action: "setPageProps", pageId, name });
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: true, pageId, name }) }],
      };
    }
  );

  server.tool(
    "send_ping",
    "Send a map ping — the animated circle that appears when you hold the mouse button. Use to direct players' attention to a location.",
    {
      pageId: z.string(),
      left: z.number().describe("X position in Roll20 canvas pixels (70px per grid square)"),
      top: z.number().describe("Y position in Roll20 canvas pixels (70px per grid square)"),
      moveAll: z.boolean().default(false).describe("If true, move all players' views to this point"),
      visibleTo: z.string().optional().describe("Player ID to restrict visibility to (omit for all players)"),
    },
    async ({ pageId, left, top, moveAll, visibleTo }) => {
      await roll20.relayCommand({ action: "sendPing", pageId, left, top, moveAll, ...(visibleTo ? { visibleTo } : {}) });
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, left, top, moveAll }) }] };
    }
  );

  const FX_TYPES = ["nova", "beam", "breath", "explode", "glow", "missile", "splatter"] as const;
  const FX_ELEMENTS = ["fire", "magic", "acid", "blood", "charm", "death", "electric", "frost", "holy", "smoke", "water"] as const;

  server.tool(
    "spawn_fx",
    "Spawn a particle effect at a point on the map. type is 'kind-element', e.g. 'nova-fire', 'explode-magic', 'beam-frost'.",
    {
      pageId: z.string(),
      x: z.number().describe("Canvas pixel X"),
      y: z.number().describe("Canvas pixel Y"),
      type: z.string().describe(`FX type string: '${FX_TYPES.join("|")}'-'${FX_ELEMENTS.join("|")}', e.g. 'nova-fire'`),
    },
    async ({ pageId, x, y, type }) => {
      await roll20.relayCommand({ action: "spawnFx", pageId, x, y, type });
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, x, y, type }) }] };
    }
  );

  server.tool(
    "spawn_fx_between_points",
    "Spawn a particle effect that travels from one point to another, e.g. a missile or beam spell.",
    {
      pageId: z.string(),
      x1: z.number(), y1: z.number(),
      x2: z.number(), y2: z.number(),
      type: z.string().describe("FX type string, e.g. 'beam-fire', 'missile-magic'"),
    },
    async ({ pageId, x1, y1, x2, y2, type }) => {
      await roll20.relayCommand({ action: "spawnFxBetweenPoints", pageId, x1, y1, x2, y2, type });
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, from: [x1, y1], to: [x2, y2], type }) }] };
    }
  );

  // ── Map pins (#203) ─────────────────────────────────────────────────────────
  // Roll20's native point-of-interest marker: an icon or image on the page with a tooltip, notes,
  // GM notes, an optional handout link, and per-audience visibility on each of those. The
  // Roll20-native way to express a module's keyed locations, and a "reveal the shrine once they
  // find it" marker (create it with visibleTo "", flip it to "all" when they find it).
  //
  // Pins are plain RTDB nodes (`pins/page/<pageId>/<pinId>`), read and written directly like doors
  // and windows — no relay action, no Mod redeploy (src/bridge/pins.ts).
  //
  // NB the property names are camelCase — `gmNotes`, `bgColor`, `pinImage` — unlike `gmnotes`
  // everywhere else in the Roll20 API. The MCP SDK validates tool args against a raw shape and
  // STRIPS unknown keys before the handler runs, so a misspelled field (`gmnotes`) is dropped, not
  // rejected. Both write tools echo the exact key list they wrote so a dropped field is visible.
  const PIN_AUDIENCE = z.enum(["all", ""]);
  const pinAudience = (what: string) =>
    PIN_AUDIENCE.describe(`Who sees ${what}: "all" for everyone, "" for the GM only.`);

  // Shared between create_map_pin and update_map_pin. No zod defaults here on purpose: an unset
  // field is left to Roll20 on create and left UNTOUCHED on update, so an update can't silently
  // reset a look. (create_map_pin applies the one deliberate default, gmNotesVisibleTo "".)
  const PIN_FIELDS = {
    title: z.string().optional().describe("Pin title, shown on the nameplate/tooltip."),
    notes: z.string().optional().describe("Player-visible notes (HTML). The Roll20 UI truncates pasted notes at 750 characters; that is a UI limit, not a storage one — this tool stores the full text."),
    gmNotes: z.string().optional().describe("GM-only notes (HTML). Note the camelCase. Same 750-char UI cap does not apply here."),
    scale: z.number().min(0.25).max(2).optional().describe("Pin size, 0.25–2.0."),
    shape: z.enum(["teardrop", "circle", "diamond", "square"]).optional(),
    bgColor: z.string().optional().describe("#RRGGBB, #RRGGBBAA, or 'transparent'."),
    customizationType: z.enum(["icon", "image"]).optional().describe("Whether the pin shows `icon` or `pinImage`."),
    icon: z.string().optional().describe("Built-in icon name, e.g. base-dot, base-castle, base-skullSimple, base-chest, base-village."),
    pinImage: z.string().optional().describe("Roll20 art-library URL, used when customizationType is 'image'."),
    useTextIcon: z.boolean().optional().describe("Show iconText instead of an icon/image."),
    iconText: z.string().optional().describe("Text for useTextIcon — Roll20 renders only the first 3 characters."),
    tooltipImage: z.string().optional().describe("Roll20 art-library URL shown in the tooltip."),
    tooltipImageSize: z.enum(["small", "medium", "large", "xl"]).optional(),
    autoNotesType: z.enum(["", "blockquote"]).optional(),
    link: z.string().optional().describe("Handout id to link this pin to."),
    linkType: z.enum(["handout", ""]).optional(),
    subLink: z.string().optional(),
    subLinkType: z.enum(["headerPlayer", "headerGM", ""]).optional(),
    visibleTo: pinAudience("the pin itself").optional(),
    tooltipVisibleTo: pinAudience("the tooltip").optional(),
    tooltipTitleVisibleTo: pinAudience("the tooltip title").optional(),
    nameplateVisibleTo: pinAudience("the nameplate").optional(),
    imageVisibleTo: pinAudience("the pin image").optional(),
    notesVisibleTo: pinAudience("the notes").optional(),
    gmNotesVisibleTo: pinAudience("the GM notes").optional().describe(
      'Who sees the GM notes. Roll20 documents the default as "all" — create_map_pin therefore writes "" (GM only) unless you say otherwise.'
    ),
    desynced: z.boolean().optional().describe(
      "Override a linked handout's content with this pin's own title/notes/image. Roll20 keeps imageDesynced/notesDesynced/gmNotesDesynced as ONE coupled flag — setting any one sets all three — so this is a single boolean."
    ),
  };
  const PIN_XY = {
    x: z.number().describe("X position in Roll20 page pixels (70px per grid square), verified live"),
    y: z.number().describe("Y position in Roll20 page pixels (70px per grid square), verified live"),
  };

  server.tool(
    "create_map_pin",
    "Place a Roll20 map pin — an interactive point-of-interest marker with a title, notes, GM notes, an optional handout link, and per-audience visibility. Use for module keyed locations, and for markers revealed later (create with visibleTo '', then update_map_pin to 'all'). Notes are NOT subject to the Roll20 UI's 750-character paste cap — a full keyed-area description fits. Pin properties are camelCase (gmNotes, bgColor, pinImage); an unknown or misspelled field is silently dropped by input validation, so check the `wrote` list in the response.",
    { pageId: z.string(), ...PIN_XY, ...PIN_FIELDS },
    async ({ pageId, ...rest }) => {
      const fields = toPinFields({ ...rest, gmNotesVisibleTo: rest.gmNotesVisibleTo ?? "" });
      const pin = await createPin(pageId, fields);
      return {
        content: [{ type: "text", text: JSON.stringify({ pinId: pin.id, pageId: pin.pageId, x: pin.x, y: pin.y, wrote: Object.keys(fields) }) }],
      };
    }
  );

  server.tool(
    "list_map_pins",
    "Read back Roll20 map pins with all their properties (position in page pixels, look, content, visibility) — enough to rebuild the set on another page. Omit pageId to list every pin in the campaign.",
    { pageId: z.string().optional() },
    async ({ pageId }) => {
      const pins = await listPins(pageId);
      return { content: [{ type: "text", text: JSON.stringify(pins) }] };
    }
  );

  server.tool(
    "update_map_pin",
    "Change an existing Roll20 map pin. Only the fields you pass are written — everything else is left alone. Flipping visibleTo to 'all' is how a hidden point of interest gets revealed. pageId is optional but saves a campaign-wide scan. An unknown or misspelled field is silently dropped by input validation, so check the `updated` list in the response.",
    {
      pinId: z.string(),
      pageId: z.string().optional().describe("Page the pin is on, if known."),
      x: PIN_XY.x.optional(),
      y: PIN_XY.y.optional(),
      ...PIN_FIELDS,
    },
    async ({ pinId, pageId, ...rest }) => {
      const result = await updatePin(pinId, toPinFields(rest), pageId);
      return { content: [{ type: "text", text: JSON.stringify({ pinId: result.id, pageId: result.pageId, updated: result.updated }) }] };
    }
  );

  server.tool(
    "delete_map_pin",
    "Delete a Roll20 map pin by id. pageId is optional but saves a campaign-wide scan.",
    { pinId: z.string(), pageId: z.string().optional() },
    async ({ pinId, pageId }) => {
      const result = await deletePin(pinId, pageId);
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, pinId: result.id, pageId: result.pageId }) }] };
    }
  );

  server.tool(
    "to_front",
    "Move a Roll20 graphic to the front (top of z-order) on its layer.",
    {
      objectId: z.string(),
      objectType: z.string().default("graphic"),
    },
    async ({ objectId, objectType }) => {
      await roll20.relayCommand({ action: "toFront", objectId, objectType });
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, objectId }) }] };
    }
  );

  server.tool(
    "to_back",
    "Move a Roll20 graphic to the back (bottom of z-order) on its layer.",
    {
      objectId: z.string(),
      objectType: z.string().default("graphic"),
    },
    async ({ objectId, objectType }) => {
      await roll20.relayCommand({ action: "toBack", objectId, objectType });
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, objectId }) }] };
    }
  );
}
