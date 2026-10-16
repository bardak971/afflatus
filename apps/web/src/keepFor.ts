import { useEffect } from "react";
import { create } from "zustand";
import { useSettings } from "./data";

/**
 * How long the library waits on its own (Settings › Storage): the days a render nobody kept has before it goes to the
 * bin, and the days the bin keeps what is in it before it is erased; 0 for never. The server's sweep acts on them;
 * here they are held for what counts down to them (a tile's clock, the status bar's chip) and for every sentence that
 * says how long ("for a week they can be restored"), dialogs and banners included, which read them when they speak.
 * A day and a week until the settings are read, as the server's defaults.
 */
export const useKeepFor = create<{ unkeptDays: number; binDays: number }>(() => ({ unkeptDays: 1, binDays: 7 }));

const DAY_MS = 24 * 60 * 60_000;

/** The days, said: "a day", "3 days", "a week", "30 days". */
export const daysSaid = (days: number) => (days === 1 ? "a day" : days === 7 ? "a week" : `${days} days`);

/** How long a render nobody kept has, in ms; null when it never goes to the bin on its own. */
export const unkeptMs = (days = useKeepFor.getState().unkeptDays): number | null => (days > 0 ? days * DAY_MS : null);

/** What Unkeep does, as its tip: back on the countdown to the bin, from now; or, when nothing goes on its own, nothing to fear. */
export const unkeepTip = (days = useKeepFor.getState().unkeptDays): string =>
  days > 0 ? `They go to the bin by themselves in ${daysSaid(days)}, counted from now` : "They stay until you bin them: nothing goes to the bin on its own";

/** How long the bin keeps what is in it, said ("a week"); null when it keeps it until it is emptied. */
export const binFor = (days = useKeepFor.getState().binDays): string | null => (days > 0 ? daysSaid(days) : null);

/**
 * What the bin does with what is in it, as a sentence's end: "for a week they can be restored from it" or, kept until
 * emptied, "they can be restored from it until it is emptied". `one`: of a single item.
 */
export function restorable(one = false, days = useKeepFor.getState().binDays): string {
  const they = one ? "it" : "they";
  return days > 0 ? `for ${daysSaid(days)} ${they} can be restored from it` : `${they} can be restored from it until it is emptied`;
}

/** The settings, as they come, put where the rest of the app reads them. Called once, by the app. */
export function useKeepForSync() {
  const s = useSettings().data;
  useEffect(() => {
    if (s) useKeepFor.setState({ unkeptDays: s.unkeptDays, binDays: s.binDays });
  }, [s]);
}

/** What an erase now is instead of: "after a week in the bin", or "waiting until the bin is emptied". */
export const insteadOfWaiting = (days = useKeepFor.getState().binDays): string => (days > 0 ? `after ${daysSaid(days)} in the bin` : "waiting until the bin is emptied");
