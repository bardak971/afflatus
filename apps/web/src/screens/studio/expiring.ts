import { create } from "zustand";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api";
import { ask } from "../../Confirm";
import { useProject } from "../../project";
import { UNKEPT_MS } from "@afflatus/core";

/**
 * The renders nobody kept, which go to the bin by themselves a day after they were made (or unkept): said once,
 * in the status bar, rather than in a bar over the library. Held here, apart from the screens, so that the status
 * bar and the library's Filters share the one filter that shows only them ("Expiring only").
 */

/** The library shows only what expires. Not remembered: a visit starts on everything. */
export const useExpiringOnly = create<{ on: boolean; set(on: boolean): void }>((set) => ({ on: false, set: (on) => set({ on }) }));

/** Beyond this many, Keep all asks first. */
const ASK_OVER = 20;

/** How long until an expiring item goes, in a few words: "40 min" under the hour, else whole hours ("3 h"), rounded down unless `up`. */
export const leftWords = (ms: number, up = false) => (ms < 3_600_000 ? `${Math.max(1, Math.round(ms / 60_000))} min` : `${(up ? Math.ceil : Math.floor)(ms / 3_600_000)} h`);

/** What the chip and its panel say of the items expiring: when the next goes and the last ("3 h", "40 min"); `soon` within the hour. */
export function expiringSaid(sum: { from: string | null; to: string | null }, now = Date.now()): { next: string; last: string; soon: boolean } | null {
  if (!sum.from || !sum.to) return null;
  const left = (at: string) => new Date(at).getTime() + UNKEPT_MS - now;
  const next = left(sum.from);
  return { next: leftWords(next), last: leftWords(left(sum.to), true), soon: next < 3_600_000 };
}

/**
 * The items expiring in the project the app looks at: how many, and when the countdown of the first and of the
 * last started. Under the "assets" key, so that a "library" event (a render, a keep, the hourly sweep) reads it
 * again; read every few minutes besides, the hours it says going down on their own.
 */
export function useExpiring() {
  const project = useProject((s) => s.id);
  return useQuery({
    queryKey: ["assets", "unkept", "all", project],
    queryFn: ({ signal }) => api.unkept({}, false, { signal }),
    refetchInterval: 5 * 60_000,
  });
}

/** Keep every item expiring in the project (asked first past a few): their ids asked for now, kept a few hundred at a time, as the server takes them. */
export function useKeepAllExpiring(onDone?: () => void) {
  const client = useQueryClient();
  const keep = useMutation({
    mutationFn: async () => {
      const ids = (await api.unkept({}, true)).ids ?? [];
      for (let i = 0; i < ids.length; i += 500) await api.bulkAssets(ids.slice(i, i + 500), "keep");
    },
    onSuccess: () => {
      // nothing is left to show only: the whole view comes back
      useExpiringOnly.getState().set(false);
      onDone?.();
      return client.invalidateQueries({ queryKey: ["assets"] });
    },
  });
  const keepAll = async (count: number) => {
    if (count > ASK_OVER && !(await ask({ title: `Keep all ${count}?`, text: `The ${count} expiring items stay until you bin them. Unkeep any of them later to put it back on its day.`, yes: `Keep ${count}` }))) return;
    keep.mutate();
  };
  return { keep, keepAll };
}
