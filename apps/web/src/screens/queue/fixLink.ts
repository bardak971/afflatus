import { TABS } from "../settings/settingsIndex";

/**
 * Where an error says its fix is in the app ("… one click in Settings → Models"): the settings tab it
 * names, as a link. null when it names none (a bare "in Settings" says too little to open a tab for).
 */
export function fixLink(error: string | null): { href: string; label: string } | null {
  const named = /\bSettings\s*[→›>]\s*([A-Za-z][A-Za-z ]*)/.exec(error ?? "");
  if (!named) return null;
  const words = named[1]!.trim().toLowerCase();
  const tab = TABS.find((t) => words === t.label.toLowerCase() || words.startsWith(`${t.label.toLowerCase()} `));
  return tab ? { href: `/settings/${tab.id}`, label: `Open Settings › ${tab.label}` } : null;
}
