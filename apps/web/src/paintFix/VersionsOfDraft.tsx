import type { Asset } from "../api";
import { useHandover } from "../store";
import { tileName } from "../screens/Library";
import { useVersions } from "./useVersions";
import { VersionStrip } from "./VersionStrip";

/**
 * The stage of a draft opened from Paint and fix's ⚙ (Open the full form): what it renders comes back as versions of its
 * picture, hidden from the library, so its own list stays empty. Said instead of "Nothing made yet", with the picture's
 * versions and those on their way (VersionStrip); a click opens the picture with that version shown, Keep works here too.
 */
export function VersionsOfDraft({ picture }: { picture: string }) {
  const versions = useVersions({ id: picture, kind: "image", inBin: false } as Asset);
  const head = versions.all[0];
  const show = (a: Asset) => useHandover.getState().set({ show: a.id });
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
      <span className="font-semibold">Came back as versions of {head ? tileName(head) : "its picture"}</span>
      <span className="text-xs text-ink-2">Its renders are versions of the picture it was opened on, not new items: a click opens the picture with that version.</span>
      {versions.has && <VersionStrip versions={versions} shown={head?.id ?? picture} onShow={show} onCompare={show} />}
    </div>
  );
}
