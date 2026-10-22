import { useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { Clapperboard, FileUp, Library, SlidersHorizontal } from "lucide-react";
import type { Clip } from "../../api";
import { ContextMenu, useMenu, type MenuItem } from "../../ContextMenu";
import { Picker } from "../../PictureField";

/**
 * What an empty lane, or a Lip sync clip's Audio cell while it has no voice, is asked for: a long video for the Source
 * lane, a voice recording past the clips, music under the whole video, or the voice of clip `n`.
 */
export type LaneAsk = { kind: "source" } | { kind: "recording" } | { kind: "music" } | { kind: "voice"; clip: Clip; n: number };

/** The kind of file each ask takes, for the picker and the file dialog. */
const KIND = { source: "video", recording: "audio", music: "audio", voice: "audio" } as const;
const ACCEPT = { video: "video/*", audio: "audio/*" } as const;

/**
 * Right-click on a lane that holds nothing yet (the lanes mock, 2026-10-22: every lane answers right-click, empty or full):
 * the library's picker of that kind, a file from the computer (into the library first, through the track's own upload),
 * and what else that lane offers. What is chosen goes where a drop on that lane puts it.
 */
export function useLaneMenus({ onSource, onRecording, onMusic, onVoice, onUpload, onSourceSettings, switchOf }: {
  onSource?(asset: string): void;
  onRecording?(asset: string): void;
  onMusic(asset: string): void;
  onVoice?(clip: string, asset: string): void;
  onUpload?(file: File): Promise<{ id: string; kind: string } | null>;
  /** The source's settings in the column (how Motion transfer cuts its windows). */
  onSourceSettings?(): void;
  /** What a Lip sync clip without a voice can be switched to: its words and the switch; null when nothing can. */
  switchOf?(clip: Clip): { title: string; run(): void } | null;
}) {
  const menu = useMenu<LaneAsk>();
  const [picking, setPicking] = useState<LaneAsk | null>(null);
  const file = useRef<HTMLInputElement>(null);
  /** The ask a file dialog was opened for: read when the file comes back. */
  const fileFor = useRef<LaneAsk | null>(null);

  const place = (ask: LaneAsk, asset: string) => {
    if (ask.kind === "source") onSource?.(asset);
    else if (ask.kind === "recording") onRecording?.(asset);
    else if (ask.kind === "music") onMusic(asset);
    else onVoice?.(ask.clip.id, asset);
  };
  const openFile = (ask: LaneAsk) => {
    fileFor.current = ask;
    if (!file.current) return;
    file.current.accept = ACCEPT[KIND[ask.kind]];
    file.current.click();
  };

  const itemsOf = (ask: LaneAsk): { head: string; sub: string; items: MenuItem[] } => {
    const open = { icon: <FileUp size={14} />, run: () => openFile(ask) };
    if (ask.kind === "source") {
      return {
        head: "Source",
        sub: "Lane · a long video for Motion transfer",
        items: [
          { label: "Choose a video from the library…", icon: <Library size={14} />, run: () => setPicking(ask) },
          ...(onUpload ? [{ label: "Open a video file…", ...open }] : []),
          ...(onSourceSettings ? ["—" as const, { label: "Motion transfer: how windows are cut…", icon: <SlidersHorizontal size={14} />, run: onSourceSettings }] : []),
        ],
      };
    }
    if (ask.kind === "voice") {
      const to = switchOf?.(ask.clip);
      return {
        head: `Clip ${ask.n}'s voice`,
        sub: "Lip sync · no voice yet",
        items: [
          { label: `Choose a recording for clip ${ask.n}…`, icon: <Library size={14} />, run: () => setPicking(ask) },
          ...(onUpload ? [{ label: "Open an audio file…", ...open }] : []),
          ...(to ? ["—" as const, { label: `Switch clip ${ask.n} to ${to.title}`, icon: <Clapperboard size={14} />, run: to.run }] : []),
        ],
      };
    }
    return {
      head: ask.kind === "music" ? "Music" : "Voice recording",
      sub: ask.kind === "music" ? "Lane · under the whole video" : "Lane · for Lip sync clips",
      items: [
        { label: ask.kind === "music" ? "Choose music from the library…" : "Choose a recording from the library…", icon: <Library size={14} />, run: () => setPicking(ask) },
        ...(onUpload ? [{ label: "Open an audio file…", ...open }] : []),
      ],
    };
  };

  const shown = menu.menu ? itemsOf(menu.menu.subject) : null;
  const node = (
    <>
      {menu.menu && shown && <ContextMenu at={menu.menu.at} label={shown.head} head={{ title: shown.head, sub: shown.sub }} items={shown.items} onClose={menu.close} />}
      {picking && (
        <Picker
          // the voice's picker is the one its form field opens (the Recording slot)
          title={picking.kind === "voice" ? "Recording" : picking.kind === "source" ? "Source" : picking.kind === "music" ? "Music" : "Voice recording"}
          kind={KIND[picking.kind]}
          onClose={() => setPicking(null)}
          onPick={(asset) => {
            place(picking, asset);
            setPicking(null);
          }}
        />
      )}
      <input
        ref={file}
        type="file"
        hidden
        aria-hidden
        tabIndex={-1}
        data-lane-file
        onChange={(e) => {
          const f = e.currentTarget.files?.[0];
          const ask = fileFor.current;
          e.currentTarget.value = "";
          if (!f || !ask || !onUpload) return;
          // into the library first, as a file dropped from the computer is; placed only as the kind the lane takes
          void onUpload(f).then((made) => {
            if (made && made.kind === KIND[ask.kind]) place(ask, made.id);
          });
        }}
      />
    </>
  );
  return { open: (e: ReactMouseEvent, ask: LaneAsk) => menu.open(e, ask), node };
}
