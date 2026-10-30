import { tabHref, TABS, type Tab } from "../settings/settingsIndex";

/** Tabs an older server's errors may still name (card #168 laid the tabs out again), and the tab that has them now. */
const OLD_NAMES: Record<string, Tab> = { access: "signin", designer: "prompts", "command bar": "interface" };

/**
 * Where an error says its fix is in the app ("… one click in Settings → Models"): the settings tab it
 * names, as a link. null when it names none (a bare "in Settings" says too little to open a tab for).
 */
export function fixLink(error: string | null): { href: string; label: string } | null {
  const named = /\bSettings\s*[→›>]\s*([A-Za-z][A-Za-z -]*)/.exec(error ?? "");
  if (!named) return null;
  const words = named[1]!.trim().toLowerCase();
  const is = (name: string) => words === name || words.startsWith(`${name} `);
  // a tab by its name, "Agents (MCP)" by "Agents" too (the brackets end the words read)
  const id = TABS.find((t) => is(t.label.toLowerCase().replace(/\s*\(.*\)$/, "")))?.id ?? Object.entries(OLD_NAMES).find(([name]) => is(name))?.[1];
  const tab = id && TABS.find((t) => t.id === id);
  return tab ? { href: tabHref(tab.id), label: `Open Settings › ${tab.label}` } : null;
}
