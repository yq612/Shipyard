// Fetches the art shown on the country cards (components/CountryCard.tsx):
//   apps/web/src/assets/flags/<code>.svg — 4:3 flag from flag-icons (MIT, see LICENSE there)
//   apps/web/src/assets/maps/<code>.svg  — 24×24 pixel silhouette from Natural Earth 1:50m (public domain)
//
//   bun run scripts/gen-country-art.ts            # every country code in config.example/ and data/ (incl. projects/)
//   bun run scripts/gen-country-art.ts PK TH      # just these
//
// Only what the config uses is vendored, so the build doesn't ship ~270 flags.
// A country without art still gets a card, just without the pictures.
// Silhouettes keep the outer rings of islands ≥1% of the country's area and
// scale longitudes by cos(mid-latitude) so shapes aren't stretched.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const NE_URL = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_50m_admin_0_countries.geojson";
const FLAG_URL = "https://raw.githubusercontent.com/lipis/flag-icons/v7.5.0/flags/4x3";
const ROOT = join(import.meta.dir, "..");
const ASSETS = join(ROOT, "apps/web/src/assets");
const G = 24; // grid size; the card shows it at 3× (72px)
const SS = 16; // supersampling per cell
const FILL = 0.45; // a cell is lit when at least this much of it is land
const MIN_ISLAND = 0.01;

type Ring = [number, number][];
type Geometry = { type: "Polygon"; coordinates: Ring[] } | { type: "MultiPolygon"; coordinates: Ring[][] };
type Feature = { properties: Record<string, string | null>; geometry: Geometry };

function configCodes(): string[] {
  const codes = new Set<string>();
  const files = ["config.example", "data"].flatMap((dir) => {
    const projects = join(ROOT, dir, "projects");
    const inProjects = existsSync(projects) ? readdirSync(projects).filter((f) => f.endsWith(".yaml")).map((f) => join(projects, f)) : [];
    return [join(ROOT, dir, "config.yaml"), ...inProjects];
  });
  for (const path of files) {
    if (!existsSync(path)) continue;
    for (const m of readFileSync(path, "utf8").matchAll(/^\s*code:\s*([A-Za-z]{2})\s*$/gm)) codes.add(m[1]!.toUpperCase());
  }
  return [...codes];
}

const ringArea = (r: Ring) => Math.abs(r.reduce((s, [x, y], i) => { const [px, py] = r[(i || r.length) - 1]!; return s + x * py - px * y; }, 0)) / 2;

// Even-odd scanline fill of all rings at SS× resolution, then box-downsample to G×G coverage.
function rasterize(rings: Ring[]): boolean[][] {
  const N = G * SS;
  const cover = new Float64Array(G * G);
  for (let sy = 0; sy < N; sy++) {
    const y = sy + 0.5;
    const xs: number[] = [];
    for (const r of rings) {
      for (let i = 0; i < r.length; i++) {
        const [x1, y1] = r[i]!;
        const [x2, y2] = r[(i + 1) % r.length]!;
        if ((y1 <= y) !== (y2 <= y)) xs.push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1));
      }
    }
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const a = Math.max(0, Math.ceil(xs[i]! - 0.5));
      const b = Math.min(N - 1, Math.floor(xs[i + 1]! - 0.5));
      for (let sx = a; sx <= b; sx++) cover[Math.floor(sy / SS) * G + Math.floor(sx / SS)]! += 1 / (SS * SS);
    }
  }
  const cells = Array.from({ length: G }, (_, y) => Array.from({ length: G }, (_, x) => cover[y * G + x]! >= FILL));
  // Never produce an empty map: light the best-covered cell.
  if (!cells.some((row) => row.some(Boolean))) {
    const best = cover.indexOf(Math.max(...cover));
    cells[Math.floor(best / G)]![best % G] = true;
  }
  return cells;
}

function toSvg(cells: boolean[][]): string {
  let d = "";
  cells.forEach((row, y) => {
    for (let x = 0; x < G; ) {
      if (!row[x]) { x++; continue; }
      const x0 = x;
      while (x < G && row[x]) x++;
      d += `M${x0} ${y}h${x - x0}v1H${x0}z`;
    }
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${G} ${G}" shape-rendering="crispEdges"><path d="${d}"/></svg>\n`;
}

function silhouette(f: Feature): string {
  const polys = f.geometry.type === "MultiPolygon" ? f.geometry.coordinates : [f.geometry.coordinates];
  let rings = polys.map((p) => p[0]!);
  const total = rings.reduce((s, r) => s + ringArea(r), 0);
  rings = rings.filter((r) => ringArea(r) >= MIN_ISLAND * total);
  const lats = rings.flat().map(([, y]) => y);
  const k = Math.cos((((Math.min(...lats) + Math.max(...lats)) / 2) * Math.PI) / 180);
  const proj = rings.map((r) => r.map(([x, y]) => [x * k, -y] as [number, number]));
  const xs = proj.flat().map(([x]) => x);
  const ys = proj.flat().map(([, y]) => y);
  const [minX, minY] = [Math.min(...xs), Math.min(...ys)];
  const [w, h] = [Math.max(...xs) - minX, Math.max(...ys) - minY];
  const s = (G * SS) / Math.max(w, h);
  const ox = (G * SS - w * s) / 2;
  const oy = (G * SS - h * s) / 2;
  return toSvg(rasterize(proj.map((r) => r.map(([x, y]) => [(x - minX) * s + ox, (y - minY) * s + oy] as [number, number]))));
}

const codes = (process.argv.length > 2 ? process.argv.slice(2) : configCodes()).map((c) => c.toUpperCase());
if (codes.length === 0) throw new Error("no country codes given and none found in config");

const res = await fetch(NE_URL);
if (!res.ok) throw new Error(`Natural Earth download failed: ${res.status}`);
const features = ((await res.json()) as { features: Feature[] }).features;
const byCode = new Map<string, Feature>();
for (const f of features) {
  const p = f.properties;
  const code = p.ISO_A2_EH && p.ISO_A2_EH !== "-99" ? p.ISO_A2_EH : p.ISO_A2;
  if (code && code !== "-99") byCode.set(code, f);
}

mkdirSync(join(ASSETS, "maps"), { recursive: true });
mkdirSync(join(ASSETS, "flags"), { recursive: true });
for (const code of codes) {
  const file = `${code.toLowerCase()}.svg`;
  const f = byCode.get(code);
  if (f) writeFileSync(join(ASSETS, "maps", file), silhouette(f));
  else console.warn(`${code}: not in Natural Earth, no map`);
  const flag = await fetch(`${FLAG_URL}/${file}`);
  if (flag.ok) writeFileSync(join(ASSETS, "flags", file), await flag.text());
  else console.warn(`${code}: no flag in flag-icons (${flag.status})`);
  console.log(`${code}: ${[f && "map", flag.ok && "flag"].filter(Boolean).join(" + ") || "nothing"}`);
}
