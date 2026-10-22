import { useState } from "react";
import type { Clip, Timeline, TimelinePatch } from "../api";
import { ContextMenu, headLine, type MenuHead, type useMenu } from "../ContextMenu";
import { Picker } from "../PictureField";
import { musicMenuItems, soundMenuItems } from "./menus";
import type { ShownPatch } from "./model";

/** The head of a clip's audio menu: what is heard, and how loud. */
const soundHead = (clips: Clip[], c: Clip): MenuHead => ({
  title: `Audio of clip ${clips.findIndex((x) => x.id === c.id) + 1}`,
  sub: headLine("Sound", c.sound === "own" ? "own audio" : c.sound === "muted" ? "muted" : "audio file", `${c.volume} %`),
});

/**
 * Right-click on a clip's audio strip and on the music strip: what the clip panel's sound section and the music panel do,
 * in place, with the audio picker each of them can open.
 */
export function SoundMenus({ t, clips, soundMenu, musicMenu, onPatch, onEdit, select, openMusic, showMusic }: {
  t: Timeline;
  /** The clips as they are shown (with the edits not saved yet). */
  clips: Clip[];
  soundMenu: ReturnType<typeof useMenu<Clip>>;
  musicMenu: ReturnType<typeof useMenu<true>>;
  onPatch(clip: string, patch: ShownPatch): void;
  onEdit(patch: TimelinePatch): void;
  select(clip: string | null): void;
  /** The music's panel opened in place of a clip's. */
  openMusic(): void;
  /** The music's panel shown, a new music picked. */
  showMusic(): void;
}) {
  const [soundPick, setSoundPick] = useState<Clip | null>(null);
  const [musicPick, setMusicPick] = useState(false);
  return (
    <>
      {soundMenu.menu && <ContextMenu at={soundMenu.menu.at} label="The audio of this clip" head={soundHead(clips, clips.find((x) => x.id === soundMenu.menu!.subject.id) ?? soundMenu.menu.subject)} items={soundMenuItems(clips.find((x) => x.id === soundMenu.menu!.subject.id) ?? soundMenu.menu.subject, { patch: onPatch, pick: setSoundPick, select })} onClose={soundMenu.close} />}
      {musicMenu.menu && <ContextMenu at={musicMenu.menu.at} label="The music" head={{ title: "Music", sub: headLine("Sound", t.music ? t.music.asset.name || null : "none yet") }} items={musicMenuItems(t.music, { pick: () => setMusicPick(true), open: openMusic, edit: onEdit })} onClose={musicMenu.close} />}
      {soundPick && <Picker title={`Audio of clip ${clips.findIndex((x) => x.id === soundPick.id) + 1}`} kind="audio" onClose={() => setSoundPick(null)} onPick={(soundAsset) => { onPatch(soundPick.id, { soundAsset }); setSoundPick(null); }} />}
      {musicPick && <Picker title="Music" kind="audio" onClose={() => setMusicPick(false)} onPick={(asset) => { onEdit({ music: { asset } }); setMusicPick(false); showMusic(); }} />}
    </>
  );
}
