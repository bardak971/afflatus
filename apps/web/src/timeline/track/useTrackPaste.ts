import type { RefObject } from "react";
import { sortPasted, usePasteTarget, type MediaKind } from "../../paste";
import { useBanners } from "../../store";

/** The track's cells a paste lands in, by their `data-paste`: the kind each takes and its name in what is said. */
const CELLS: Record<string, { kind: MediaKind; label: string }> = {
  recording: { kind: "audio", label: "A voice recording" },
  source: { kind: "video", label: "The source" },
  music: { kind: "audio", label: "Music" },
  voice: { kind: "audio", label: "A clip's voice" },
  sound: { kind: "audio", label: "A clip's audio" },
};

/**
 * Ctrl+V on one of the track's drop cells holding the focus (the end column's Audio and Source, the Music lane, a clip's
 * Audio cell): the first file as a drop of it there, through the track's own upload, a file the library holds already
 * used as it is. The focus anywhere else on the track: not the track's, the paste goes on to the library.
 */
export function useTrackPaste({ area, onUpload, onSource, onRecording, onMusic, onClipSound, onVoice }: {
  area: RefObject<HTMLElement | null>;
  onUpload?(file: File, reuse?: boolean): Promise<{ id: string; kind: string } | null>;
  onSource?(asset: string): void;
  onRecording?(asset: string): void;
  onMusic(asset: string): void;
  onClipSound(clip: string, asset: string): void;
  onVoice?(clip: string, asset: string): void;
}): void {
  const say = useBanners((b) => b.push);
  usePasteTarget(onUpload ? {
    level: "slot",
    el: () => area.current,
    take: (files, focused) => {
      const cell = focused instanceof HTMLElement ? focused.closest<HTMLElement>("[data-paste]") : null;
      const at = cell?.dataset.paste;
      const clip = cell?.dataset.pasteClip;
      if (!at || !CELLS[at]) return false;
      const { taken, said } = sortPasted(files, CELLS[at].kind, CELLS[at].label);
      if (said) say({ id: `paste-cell:${Date.now()}`, tone: "bad", title: said });
      const file = taken[0];
      if (!file) return;
      void onUpload(file, true).then((made) => {
        if (!made) return;
        if (at === "source") onSource?.(made.id);
        else if (at === "recording") onRecording?.(made.id);
        else if (at === "music") onMusic(made.id);
        else if (at === "voice" && clip) onVoice?.(clip, made.id);
        else if (at === "sound" && clip) onClipSound(clip, made.id);
      });
    },
  } : null);
}
