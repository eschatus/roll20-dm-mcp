import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as roll20 from "../bridge/roll20.js";

// Screenshot is dual-use: map prep (verify a placed map / walls) AND live play
// (a combat assistant "sees" the board). Extracted from vision.ts so it can be
// registered in BOTH the maps suite and the combat server while the rest of the
// vision/wall tooling stays maps-only.
export function registerScreenshotTools(server: McpServer): void {
  server.tool(
    "screenshot_roll20",
    "Take a screenshot of the current Roll20 editor view and save it to a local file path. Optionally clip to a region of the browser viewport in screen pixels.",
    {
      outputPath: z.string().describe("Absolute path to save the PNG screenshot"),
      dlEditor: z.boolean().optional().describe("If true, press Ctrl+, to enter DL wall editor before screenshotting (shows walls as colored lines), then exit afterward"),
      clipX: z.number().optional().describe("Screen pixel x to start clip (default: full viewport)"),
      clipY: z.number().optional().describe("Screen pixel y to start clip"),
      clipWidth: z.number().optional().describe("Clip width in screen pixels"),
      clipHeight: z.number().optional().describe("Clip height in screen pixels"),
    },
    async ({ outputPath, dlEditor, clipX, clipY, clipWidth, clipHeight }) => {
      const clip = (clipX != null && clipY != null && clipWidth != null && clipHeight != null)
        ? { x: clipX, y: clipY, width: clipWidth, height: clipHeight }
        : undefined;
      await roll20.takeScreenshot(outputPath, clip, dlEditor ?? false);
      return { content: [{ type: "text", text: JSON.stringify({ saved: outputPath, dlEditor, clip }) }] };
    }
  );
}
