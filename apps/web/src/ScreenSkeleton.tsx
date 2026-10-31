import { SETTING_TABS, SETTING_TABS_MOVED } from "@afflatus/core";
import { useLocation } from "wouter";
import { PageHeader, Segmented } from "./ui";

/**
 * The screens that are chunks of their own, as their header says them: drawn at once while the chunk comes (card #179), where a
 * bare "Loading…" took the whole page and the header and tabs then jumped in. Settings' tabs work already: one picked goes there.
 */
const SCREENS: Array<{ at: RegExp; title: string }> = [
  { at: /^\/settings(\/|$)/, title: "Settings" },
  { at: /^\/queue(\/|$)/, title: "Queue" },
  { at: /^\/kit(\/|$)/, title: "Prompt kit" },
  { at: /^\/workflows(\/|$)/, title: "Workflows" },
];

/** A screen whose code is on its way: its title (and Settings' tab bar), and cards in the shape of what comes. */
export function ScreenSkeleton({ path }: { path: string }) {
  const [, go] = useLocation();
  const screen = SCREENS.find((s) => s.at.test(path));
  // the tab the address lands on: an old one's (/settings/access, /settings/bar) is the tab that has its settings now
  const asked = path.split("/")[2] || "comfyui";
  const tab = SETTING_TABS_MOVED[asked] ?? asked;
  const tabs = screen?.title === "Settings" ? (
    <Segmented oneLine className="w-max" label="Settings" value={tab} options={SETTING_TABS.map((t) => ({ value: t.id, label: t.label }))} onChange={(t) => go(t === "comfyui" ? "/settings" : `/settings/${t}`)} />
  ) : undefined;
  return (
    <div aria-busy="true" className="flex min-h-0 grow flex-col overflow-hidden">
      {screen && <PageHeader title={screen.title} after={tabs} folds={tabs ? 4 : 0} titleYields={Boolean(tabs)} />}
      <div className="grid grid-cols-1 gap-4 px-8 pt-5 xl:grid-cols-2">
        {[0, 1, 2, 3].map((i) => <span key={i} className="m-skeleton h-40 rounded-2xl" />)}
      </div>
    </div>
  );
}
