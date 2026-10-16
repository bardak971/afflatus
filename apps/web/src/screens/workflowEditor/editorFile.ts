/**
 * A model file the import screen replaced: in node `node` (the graph's id), the value `from` the file named (null: the
 * workflow named none there as it came, a field read again once its pack was in), now `to`.
 */
export interface FileSwap {
  node: string;
  from: string | null;
  to: string;
}

/**
 * The editor's own file with the files replaced on the import screen written into its widgets, so that Open in ComfyUI
 * shows the file Afflatus renders with. Undefined when a replacement cannot be placed (a node inside a subgraph, a value
 * the file does not hold as it is): the server then writes the editor's file from the graph, which has every replacement,
 * rather than ComfyUI opening the workflow on a file it does not have.
 */
export function editorWithSwaps(editor: unknown, swaps: FileSwap[]): unknown {
  if (!swaps.length) return editor;
  if (!editor || typeof editor !== "object" || !Array.isArray((editor as { nodes?: unknown }).nodes)) return undefined;
  const file = structuredClone(editor) as { nodes: Array<{ id?: unknown; widgets_values?: unknown }> };
  for (const s of swaps) {
    const node = file.nodes.find((n) => String(n.id) === s.node);
    const values = node?.widgets_values;
    let placed = false;
    // a node that keeps its widgets by name (Video Helper Suite's loaders) is written by name, the rest by place
    const byKey = (Array.isArray(values) ? values : values && typeof values === "object" ? values : {}) as Record<string, unknown>;
    for (const [k, v] of Object.entries(byKey)) {
      if (v !== s.from) continue;
      byKey[k] = s.to;
      placed = true;
    }
    if (!placed || s.from === null) return undefined;
  }
  return file;
}
