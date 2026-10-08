import type { Entity } from "../api";

type Snippet = Extract<Entity, { kind: "snippet" }>;

/** One snippet of each category, picked at random: a new combination to try. */
export function rollSnippets(snippets: Snippet[], random: () => number = Math.random): string[] {
  const groups = new Map<string, Snippet[]>();
  for (const s of snippets) {
    if (!s.def.category) continue;
    groups.set(s.def.category, [...(groups.get(s.def.category) ?? []), s]);
  }
  return [...groups.values()].map((pool) => pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))]!.id);
}
