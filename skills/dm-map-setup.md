# Skill: DM Map Setup

Import a battlemap and configure dynamic lighting walls in Roll20. The tools handle geometry; this skill handles judgment.

## Philosophy

- **Walls cover structure, not detail.** DL lines trace load-bearing walls and major partitions. Furniture, pillars, and decorative features are not traced unless they're actually blocking.
- **Gaps are intentional.** Doorways, windows, and secret doors are left as gaps. The DM decorates those afterward with Roll20 door/window objects.
- **Rough walls get more give.** Stone dungeons and natural caves use larger insets. Clean corridors and interiors use tighter values.
- **Players should see wall texture.** Lines pull slightly back from open ends so light grazes the wall face rather than creating a hard black box.
- **Corners are closed.** Lines extend slightly past junctions so light doesn't leak through pixel gaps at corners.
- **Segments stay editable.** Long straight runs are split into manageable chunks so the DM can nudge individual pieces without wrestling with a single massive path.

## Steps

### 1. Get the image

- If the DM provided a local file path → use it directly
- If the DM described a scene → call `search_battlemap` to surface candidates, confirm before continuing

### 2. Analyze the map

Call `analyze_battlemap({ imagePath })`.

Returns:
- `gridSizePx` — pixel width of one grid square
- `gridOffsetX`, `gridOffsetY` — offset to first grid line
- `walls` — centerline segments as `{ from: [x,y], to: [x,y] }`
- `estimatedTokens` and `imageDimensions` — report these to the DM

If the token estimate seems high (>20,000), ask before proceeding or lower `maxDimensionPx`.

### 3. Create the Roll20 page

Call `setup_roll20_page({ name, widthSquares, heightSquares, scaleNumber, scaleUnits })`.

Ask the DM for the page name if not provided. Default: 30×20 squares, 5ft scale.

### 4. Place DL walls and decorate openings

Call `auto_place_dl_walls` with the walls from step 2. **Always pass `strokeColor: "#0044FF"`**
(blue) for DL walls — the tool defaults to yellow `#FFFF00`, which violates the project convention
(blue for walls, green for windows). Tune the geometry for the map type:

**Stone dungeon / cave (rough walls):**
```
endpointInsetPx: 6        ← more give, texture shows
cornerOverlapPx: 5        ← tight corner closure
cornerThresholdPx: 12     ← loose corner detection for rough geometry
maxSegmentPx: 180         ← shorter chunks, easier to nudge individual stones
```

**Interior rooms / built structures (clean walls):**
```
endpointInsetPx: 4
cornerOverlapPx: 4
cornerThresholdPx: 8
maxSegmentPx: 220
```

**Outdoors / forest / organic shapes:**
```
endpointInsetPx: 8        ← lots of give, organic edges
cornerOverlapPx: 3
cornerThresholdPx: 15     ← very loose, organic shapes don't have tight corners
maxSegmentPx: 150         ← short chunks match organic curves
```

If the DM hasn't specified a wall type, look at the map and pick the closest profile. Mention which profile you used.

(If you instead place an organic perimeter with `place_polyline_walls`, pass `strokeColor: "#0044FF"` there too — it carries the same yellow `#FFFF00` default.)

After placing DL walls, immediately call `decorate_openings` with the `doors`, `windows`, and `secretDoors` arrays from the analysis. It creates **native Roll20 Dynamic Lighting door/window objects** (not map-layer rectangles), color-coded so you can tell them apart in the editor:

- **Doors** → red (`#FF0000`) DL door objects (`createDLDoors`)
- **Windows** → cyan (`#00FFFF`) DL window objects (`createDLWindows`)
- **Secret doors** → purple (`#9932CC`) DL door objects (`createDLDoors`)

(If the source image isn't already in Roll20 canvas pixels, also pass `sourceImageWidth`/`sourceImageHeight` + `pageWidthSquares`/`pageHeightSquares` so the markers scale correctly — otherwise they place at 1:1.)

This is automatic — do not ask the DM before doing it.

### 5. Report back

Report:
- Page name and ID
- Grid detected: `Xpx/square` (or "no grid detected, used Roll20 default 140px")
- Walls placed: `X/Y segments` (input → after splitting)
- Openings decorated: `X doors, Y windows, Z secret doors (GM layer)`
- Token cost: `~X tokens (~$Y at Sonnet pricing)`
- Wall profile used

Then:
> "Red = doors, cyan = windows, purple = secret doors — placed as native Roll20 DL door/window objects. Tune or remove them in the Dynamic Lighting editor (they're DL objects, not images to swap). Enable Dynamic Lighting on this page when ready."

## Tuning guidance (if the DM wants to adjust)

| Problem | Fix |
|---|---|
| Light leaking through corners | raise `cornerOverlapPx` |
| Open doorways are too dark | lower `endpointInsetPx` |
| Gaps at secret doors look too obvious | lower `endpointInsetPx` |
| Segments too long to select individually | lower `maxSegmentPx` |
| Corner detection catching doorways as corners | lower `cornerThresholdPx` |
| Analysis missed walls | raise `maxDimensionPx` (more detail, more tokens) |

## Example

> "Set up the crypt level — here's the image: ./maps/crypt.png"

Claude:
1. Calls `analyze_battlemap({ imagePath: "./maps/crypt.png" })` → 3,200 tokens, 1500×1100px, 38 wall segments, 4 doors, 0 windows, 1 secret door, 140px grid
2. Calls `setup_roll20_page({ name: "Crypt Level", widthSquares: 28, heightSquares: 20 })`
3. Identifies map as stone dungeon → uses rough-walls profile
4. Calls `auto_place_dl_walls({ walls: [...], strokeColor: "#0044FF", endpointInsetPx: 6, cornerOverlapPx: 5, cornerThresholdPx: 12, maxSegmentPx: 180 })`
5. Calls `decorate_openings({ doors: [...], windows: [], secretDoors: [...] })`
6. Reports: "Page 'Crypt Level' created. 52 DL wall segments (38 → 52 after splitting), blue. 4 doors (red), 1 secret door (purple). ~3,200 tokens (~$0.01). Stone dungeon profile. Enable DL when ready."
