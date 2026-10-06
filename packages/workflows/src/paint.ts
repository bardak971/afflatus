import type { Toggle } from "./types";

/**
 * Colouring, in the file ComfyUI opens, the nodes each switch made in Afflatus covers: the reach of a
 * switch is then seen in ComfyUI's own editor, where the person checks such things. The file's own
 * switches (the author's bypass groups) are left as the author drew them. ComfyUI's own palette, one
 * colour per switch, the title bar and the body each a shade of it.
 */
const PALETTE: Array<{ color: string; bgcolor: string }> = [
  { color: "#232", bgcolor: "#353" }, // green
  { color: "#223", bgcolor: "#335" }, // blue
  { color: "#323", bgcolor: "#535" }, // purple
  { color: "#432", bgcolor: "#653" }, // yellow
  { color: "#233", bgcolor: "#355" }, // cyan
  { color: "#332922", bgcolor: "#593930" }, // brown
  { color: "#322", bgcolor: "#533" }, // red
  { color: "#2a363b", bgcolor: "#3f5159" }, // pale blue
];

interface PaintedNode { id?: unknown; color?: string; bgcolor?: string; title?: string }

/** The file with the switched nodes coloured: a copy, the given one untouched. Nothing happens to a file with no nodes list or to a workflow with no made switch. */
export function paintSwitches<T>(file: T, toggles: Toggle[]): T {
  const made = toggles.filter((t) => t.made);
  const nodes = (file as { nodes?: unknown })?.nodes;
  if (!made.length || !Array.isArray(nodes)) return file;
  const copy = structuredClone(file) as T & { nodes: PaintedNode[] };
  const byId = new Map(copy.nodes.map((n) => [String(n.id), n]));
  made.forEach((t, i) => {
    const paint = PALETTE[i % PALETTE.length]!;
    for (const id of new Set(t.effects.flatMap((e) => e.nodes))) {
      // a node inside a group node ("3:20") is not in the file's top list: left alone
      const node = byId.get(id);
      if (node) Object.assign(node, paint);
    }
  });
  return copy;
}
