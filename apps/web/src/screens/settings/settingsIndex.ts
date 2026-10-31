/** The tabs of Settings and every setting by the words someone would look for: the screen's search and the command bar's `/` read them. */

import { SETTING_INDEX, SETTING_TABS, SETTING_TABS_MOVED, settingSpot } from "@afflatus/core";

export const TABS = SETTING_TABS;
export type Tab = (typeof TABS)[number]["id"];

/** Tabs that were merged into another or renamed: an old address (/settings/appearance, /settings/access) still opens the right one. */
export const MOVED: Record<string, Tab> = SETTING_TABS_MOVED;

/** Every setting, by the words someone would look for (core's settingsIndex.ts: the server names a setting's tab by it too). */
export const INDEX = SETTING_INDEX;

/** A tab's address: ComfyUI's is Settings itself. */
export const tabHref = (tab: Tab) => (tab === "comfyui" ? "/settings" : `/settings/${tab}`);

/** The setting of a key (or of one of the command bar's ids in `also`). */
export const spotOf = settingSpot;

/**
 * Where a setting is: its tab with `?find=<key>`. Settings opens the tab, scrolls to the row that carries
 * `data-setting="<key>"` and outlines it until the next click. A key it does not know opens `tab` (or Settings).
 */
export function settingHref(key: string, tab?: Tab): string {
  const spot = spotOf(key);
  if (!spot) return tabHref(tab ?? "comfyui");
  return `${tabHref(spot.tab)}?find=${encodeURIComponent(spot.key)}`;
}

/**
 * Where an address of Settings lands: the tab its path names (an old tab's, /settings/access, the tab that has its
 * settings now; one unknown, ComfyUI), and where to send it on, if anywhere. A setting asked for (`?find=`, or an old
 * `#key`) on a tab it is not on goes to its own tab; an old tab's address is put right, so that what is bookmarked next
 * is the new one. Card #168 laid the tabs out again: every old link lands through this.
 */
export function landing(asked: string | undefined, find: string | null): { tab: Tab; to: string | null } {
  const moved = asked ? MOVED[asked] : undefined;
  const tab: Tab = moved ?? (TABS.some((t) => t.id === asked) ? (asked as Tab) : "comfyui");
  const spot = find ? spotOf(find) : undefined;
  if (spot && spot.tab !== tab) return { tab, to: settingHref(spot.key) };
  return { tab, to: moved ? `${tabHref(moved)}${find && spot ? `?find=${encodeURIComponent(spot.key)}` : ""}` : null };
}
