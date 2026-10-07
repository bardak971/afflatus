import type { BuildContext, GraphBuilder, InputSpec, Ref } from "@afflatus/core";

/**
 * A second pass in tiles, as Ultimate SD Upscale does it: the enlarged picture is cut into overlapping tiles
 * the model's own size, each is redrawn lightly, and they are put back with their overlaps blended. Each tile
 * is a small picture to the model, so a picture of any size takes no more memory than one tile, and every tile
 * gets the detail of a picture drawn at the model's own size. Made of ComfyUI's own tile nodes: no pack.
 */
export interface TileSettings {
  /** Auto, Whole picture or Tiles. */
  tiles: string;
  tileSize: number;
  tileOverlap: number;
}

export const TILES_AUTO = "Auto";
export const TILES_WHOLE = "Whole picture";
export const TILES_ON = "Tiles";
export const TILE_NODES = ["SplitImageToTileList", "ImageMergeTileList"];
export const TILES_NEEDED = "Redrawing in tiles needs ComfyUI's SplitImageToTileList and ImageMergeTileList nodes, which came with a recent ComfyUI: update ComfyUI, or pick Whole picture.";

/** The tile inputs, under a switch or a pass that shows them (`showWhen`). */
export const tileInputs = (showWhen: string | undefined, tile = 1024): InputSpec[] => [
  {
    id: "tiles", type: "choice", label: "Redraw", options: [TILES_AUTO, TILES_WHOLE, TILES_ON], default: TILES_AUTO, ...(showWhen ? { showWhen } : {}), advanced: true, perModel: true,
    note: "Tiles redraw a large picture piece by piece, as Ultimate SD Upscale does: any size fits in memory and each piece gets full detail. Auto uses tiles past about 2× each side of the model's usual size",
  },
  { id: "tileSize", type: "number", label: "Tile size", note: "the model's own size is best (1024 for SDXL and Flux)", min: 512, max: 2048, step: 64, default: tile, unit: "px", ...(showWhen ? { showWhen } : {}), advanced: true, perModel: true },
  { id: "tileOverlap", type: "number", label: "Tile overlap", note: "how far tiles overlap, blended where they meet: more hides seams, at more tiles", min: 32, max: 512, step: 16, default: 128, unit: "px", ...(showWhen ? { showWhen } : {}), advanced: true, perModel: true },
];

/** Whether a pass at this size is redrawn in tiles: asked, or (Auto) the picture is past four times `area` (2× each side). */
export function useTiles(input: TileSettings, size: { width: number; height: number }, area: number): boolean {
  if (input.tiles === TILES_ON) return true;
  if (input.tiles === TILES_WHOLE) return false;
  return size.width * size.height > 4 * area;
}

/** The nodes tiles bring in. */
export const tileNodes = (on: boolean) => (on ? [...TILE_NODES, "VAEEncode", "VAEDecode"] : []);

/**
 * A picture redrawn in tiles: cut, each tile encoded, sampled by `sample` (the pass's sampler, at its light
 * denoise), decoded, and put back at the picture's size. ComfyUI runs the nodes between once per tile.
 */
export function redrawInTiles(g: GraphBuilder, ctx: BuildContext, picture: Ref, vae: Ref, size: { width: number; height: number }, input: TileSettings, sample: (latent: Ref, tiles: Ref, tile: number) => Ref): Ref {
  if (!TILE_NODES.every((n) => ctx.has(n))) throw new Error(TILES_NEEDED);
  const tile = Math.min(input.tileSize, Math.max(size.width, size.height));
  const overlap = Math.min(input.tileOverlap, Math.floor(tile / 4));
  const pieces = g.out("SplitImageToTileList", { image: picture, tile_width: tile, tile_height: tile, overlap });
  const latents = g.out("VAEEncode", { pixels: pieces, vae });
  const redrawn = g.out("VAEDecode", { samples: sample(latents, pieces, tile), vae });
  return g.out("ImageMergeTileList", { image_list: redrawn, final_width: size.width, final_height: size.height, overlap });
}
