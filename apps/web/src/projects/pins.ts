import { useQueryClient } from "@tanstack/react-query";
import { api, type Project, type Settings } from "../api";
import { useProjects, useSettings } from "../data";
import { queryKeys } from "../queryKeys";
import { useSayFailed } from "../sayFailed";

/** How many projects the rail holds under the one worked in. */
const PIN_LIMIT = 4;

/** The pins that are still places to switch to: projects there and not archived, and the Inbox ("none"), each once, in order. */
export function livePins(pins: readonly string[], projects: readonly Pick<Project, "id" | "archivedAt">[] | undefined): string[] {
  const live = new Set((projects ?? []).filter((p) => !p.archivedAt).map((p) => p.id));
  return [...new Set(pins)].filter((id) => id === "none" || !projects || live.has(id)).slice(0, PIN_LIMIT);
}

/** A pin dragged from one place of the row to another (`to`: the place it is dropped on, before what was there). */
export function movePin(pins: readonly string[], id: string, to: number): string[] {
  const rest = pins.filter((p) => p !== id);
  const at = Math.max(0, Math.min(rest.length, to > pins.indexOf(id) && pins.includes(id) ? to - 1 : to));
  return [...rest.slice(0, at), id, ...rest.slice(at)];
}

/**
 * The projects pinned to the rail (the server setting `pinnedProjects`): read with the settings, changed at once on screen
 * and saved; a save that fails puts them back and says so.
 */
export function usePins() {
  const client = useQueryClient();
  const settings = useSettings();
  const projects = useProjects();
  const failed = useSayFailed({ id: "pins", href: "/", go: "Open the Studio" });
  const ids = livePins(settings.data?.pinnedProjects ?? [], projects.data?.items);
  const save = (next: string[]) => {
    const was = client.getQueryData<Settings>(queryKeys.settings());
    if (was) client.setQueryData<Settings>(queryKeys.settings(), { ...was, pinnedProjects: next });
    api.saveSettings({ pinnedProjects: next }).then(
      (saved) => client.setQueryData(queryKeys.settings(), saved),
      (err: unknown) => {
        if (was) client.setQueryData(queryKeys.settings(), was);
        failed("The rail's pins could not be saved")(err);
      },
    );
  };
  return {
    ids,
    ready: settings.isSuccess,
    full: ids.length >= PIN_LIMIT,
    has: (id: string) => ids.includes(id),
    pin: (id: string) => !ids.includes(id) && ids.length < PIN_LIMIT && save([...ids, id]),
    unpin: (id: string) => save(ids.filter((p) => p !== id)),
    move: (id: string, to: number) => save(movePin(ids, id, to)),
  };
}
