/**
 * Shared numeric constants for the roll20-dm-mcp servers.
 */

/**
 * Roll20's default grid cell size in pixels. One 5ft battle-grid square = 70px.
 *
 * NOTE: `const CELL = 70` is currently duplicated ~11x across
 * src/tools/tokens.ts, src/tools/maps.ts, and src/tools/vision.ts.
 * Those call sites should be migrated to import ROLL20_GRID_PX from here.
 * Migration of those files is a follow-up owned by their respective teams —
 * do not change them as part of this constant's introduction.
 */
export const ROLL20_GRID_PX = 70;
