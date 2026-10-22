import { useQueryClient } from "@tanstack/react-query";
import { api, type Settings } from "../api";
import { useSettings } from "../data";
import { movePin } from "../projects/pins";
import { queryKeys } from "../queryKeys";
import { useSayFailed } from "../sayFailed";

/** Every family's pins with one family's list put in: a family left with none is taken out, so that Forget has nothing to clear. */
export function withFamilyPins(all: Readonly<Record<string, string[]>>, family: string, ids: readonly string[]): Record<string, string[]> {
  const rest = Object.fromEntries(Object.entries(all).filter(([k]) => k !== family));
  return ids.length ? { ...rest, [family]: [...new Set(ids)] } : rest;
}

/**
 * The fields pinned to the top of a model's forms (the server setting `pinnedFields`), for one family: every form of it shares
 * them, the H3 forms (Video with audio, Lip sync, Swap character, Motion transfer) with each other, as they share the family
 * "h3". Read with the settings, changed at once on screen and saved; a save that fails puts them back and says so. `ids` is
 * the list as kept: an id the form at hand does not have is the form's to skip.
 */
export function usePinnedFields(family: string) {
  const client = useQueryClient();
  const settings = useSettings();
  const failed = useSayFailed({ id: "pinned-fields", once: true });
  const ids = settings.data?.pinnedFields?.[family] ?? [];
  const save = (next: string[]) => {
    const was = client.getQueryData<Settings>(queryKeys.settings());
    // the whole record is sent: what another family holds is read from the settings as they are now, not as first drawn
    const all = withFamilyPins(was?.pinnedFields ?? settings.data?.pinnedFields ?? {}, family, next);
    if (was) client.setQueryData<Settings>(queryKeys.settings(), { ...was, pinnedFields: all });
    api.saveSettings({ pinnedFields: all }).then(
      (saved) => client.setQueryData(queryKeys.settings(), saved),
      (err: unknown) => {
        if (was) client.setQueryData(queryKeys.settings(), was);
        failed("The pinned fields could not be saved")(err);
      },
    );
  };
  return {
    ids,
    has: (id: string) => ids.includes(id),
    pin: (id: string) => !ids.includes(id) && save([...ids, id]),
    unpin: (id: string) => save(ids.filter((p) => p !== id)),
    /** `to`: the place in the kept list it is put before (the list's length: last), as the rail's pins move. */
    move: (id: string, to: number) => save(movePin(ids, id, to)),
  };
}

/** Settings › Interface's "Forget pinned fields": how many are pinned over how many families, and the way to clear them all. */
export function useForgetPinnedFields() {
  const client = useQueryClient();
  const settings = useSettings();
  const failed = useSayFailed({ id: "pinned-fields", once: true, href: "/settings/interface", go: "Open Settings" });
  const all = settings.data?.pinnedFields ?? {};
  const fields = Object.values(all).reduce((n, ids) => n + ids.length, 0);
  const forget = () => {
    const was = client.getQueryData<Settings>(queryKeys.settings());
    if (was) client.setQueryData<Settings>(queryKeys.settings(), { ...was, pinnedFields: {} });
    api.saveSettings({ pinnedFields: {} }).then(
      (saved) => client.setQueryData(queryKeys.settings(), saved),
      (err: unknown) => {
        if (was) client.setQueryData(queryKeys.settings(), was);
        failed("The pinned fields could not be forgotten")(err);
      },
    );
  };
  return { fields, families: Object.keys(all).length, forget };
}
