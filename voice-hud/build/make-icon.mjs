// Generate the app icon from the HUD's scrying-gem look (build/icon.png).
// The gem itself is CSS-rendered in the renderer; this is a faithful vector recreation of its
// idle/bright state — the same cushion silhouette (gem.html .cushion clip-path), the emerald
// step-cut terracing (gem-deep → gem-dark → gem → s3 → table), and the rose palette (--gem
// #b43c5a). Rasterized with sharp (already a dep) so it's reproducible: `node build/make-icon.mjs`.
import sharp from "sharp";
import { fileURLToPath } from "url";
import * as path from "path";

const SIZE = 1024;
const C = SIZE / 2;

// Palette — the color-mix() values from gem.html resolved to hex.
const GEM = "#b43c5a";
const DEEP = "#36121b";   // 30% gem + black   (outer step)
const DARK = "#632131";   // 55% gem + black
const S3   = "#bd546e";   // 78% gem + gem-light
const LIGHT = "#dda7b5";  // 45% gem + white   (table highlight)

// The cushion silhouette from .cushion { clip-path: polygon(...) }, as box fractions.
const CUSHION = [[.18,.04],[.82,.04],[.96,.26],[1,.5],[.96,.74],[.82,.96],[.18,.96],[.04,.74],[0,.5],[.04,.26]];
const cushion = (scale) => {
  const s = SIZE * 0.74 * scale;            // outer gem spans ~74% of the canvas (margin for glow)
  return CUSHION.map(([fx, fy]) => `${(C - s/2 + fx*s).toFixed(1)},${(C - s/2 + fy*s).toFixed(1)}`).join(" ");
};

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  <defs>
    <radialGradient id="table" cx="44%" cy="34%" r="78%">
      <stop offset="0%"  stop-color="${LIGHT}"/>
      <stop offset="58%" stop-color="${GEM}"/>
      <stop offset="100%" stop-color="${DARK}"/>
    </radialGradient>
    <linearGradient id="glare" x1="0" y1="0" x2="1" y2="1">
      <stop offset="34%" stop-color="#ffffff" stop-opacity="0"/>
      <stop offset="48%" stop-color="#ffffff" stop-opacity="0.30"/>
      <stop offset="62%" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    <filter id="glow" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="22"/>
    </filter>
    <clipPath id="outer"><polygon points="${cushion(1)}"/></clipPath>
  </defs>

  <!-- outer glow in the gem color -->
  <polygon points="${cushion(1.02)}" fill="${GEM}" opacity="0.45" filter="url(#glow)"/>

  <!-- emerald step-cut terrace: each smaller cushion a shade lighter, stacked inward -->
  <polygon points="${cushion(1.0)}"  fill="${DEEP}"/>
  <polygon points="${cushion(0.86)}" fill="${DARK}"/>
  <polygon points="${cushion(0.72)}" fill="${GEM}"/>
  <polygon points="${cushion(0.58)}" fill="${S3}"/>
  <polygon points="${cushion(0.44)}" fill="url(#table)"/>

  <!-- diagonal glare streak, clipped to the gem silhouette -->
  <g clip-path="url(#outer)"><rect x="0" y="0" width="${SIZE}" height="${SIZE}" fill="url(#glare)"/></g>
</svg>`;

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "icon.png");
await sharp(Buffer.from(svg)).resize(SIZE, SIZE).png().toFile(out);
console.log("wrote", out);
