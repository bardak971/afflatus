import type { QueryClient } from "@tanstack/react-query";
import { navigate } from "wouter/use-browser-location";
import { api } from "./api";
import { askChoice } from "./Confirm";
import { useDraftsChanged } from "./draft";
import { plural } from "./format";
import { queryKeys } from "./queryKeys";
import { failedBanner } from "./sayFailed";
import { useBanners, useOpenDraft, useStudio } from "./store";

/**
 * Before items go to the bin: the bin refuses one a draft still uses (its forms name it, or it is what the draft edits),
 * so the drafts in the way are named first, each a link to open it, and the user picks: take the items out of those
 * drafts (their fields go back to empty), or delete the drafts. Several items, several drafts: one question for all.
 * Answers whether to go on with the bin. A failed ask lets it go on: the bin's own refusal then says why.
 */
export async function clearDraftUse(client: QueryClient, ids: string[]): Promise<boolean> {
  const drafts = await api.draftsUsing(ids).then((r) => r.drafts, () => []);
  if (!drafts.length) return true;
  const used = [...new Set(drafts.flatMap((d) => d.assets))];
  const one = used.length === 1;
  const many = drafts.length > 1;
  const how = await askChoice({
    title: `${ids.length === 1 ? "This item is" : `${plural(used.length, "item")} of these ${one ? "is" : "are"}`} used by ${plural(drafts.length, "draft")}`,
    text: `Take ${one ? "it" : "them"} out of ${many ? "those drafts" : "the draft"} (${one ? "its field goes" : "their fields go"} back to empty), or delete ${many ? "the drafts" : "the draft"}. Then ${one ? "it goes" : "they go"} to the bin.`,
    links: drafts.map((d) => ({
      label: `${d.name || "Untitled draft"}${used.length > 1 ? ` · ${plural(d.assets.length, "item")}` : ""}`,
      run: () => {
        useOpenDraft.getState().open(d.id);
        useStudio.getState().set({ form: true, scope: "draft" });
        navigate("/");
      },
    })),
    choices: [
      { value: "release", label: one ? "Take it out" : "Take them out" },
      { value: "delete", label: many ? `Delete the ${drafts.length} drafts` : "Delete the draft" },
    ],
    no: "Cancel",
  });
  if (!how) return false;
  try {
    if (how === "release") {
      await api.releaseFromDrafts(used);
      useDraftsChanged.getState().say({ released: used });
      for (const d of drafts) void client.invalidateQueries({ queryKey: queryKeys.drafts.one(d.id) });
    } else {
      for (const d of drafts) {
        await api.deleteDraft(d.id);
        client.removeQueries({ queryKey: queryKeys.drafts.one(d.id) });
      }
      useDraftsChanged.getState().say({ deleted: drafts.map((d) => d.id) });
    }
  } catch (err) {
    useBanners.getState().push(failedBanner({ id: "draft-use", once: true, href: "/", go: "Open the Studio" }, how === "release" ? "Could not take them out of the drafts" : "Could not delete the drafts", err));
    return false;
  } finally {
    void client.invalidateQueries({ queryKey: queryKeys.drafts.lists() });
  }
  return true;
}
