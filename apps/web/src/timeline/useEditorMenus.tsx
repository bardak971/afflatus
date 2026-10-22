import type { RefObject } from "react";
import type { Clip } from "../api";
import { headLine, useMenu, type MenuHead } from "../ContextMenu";
import { clock as mmss } from "../format";
import type { PinWhere } from "./model";
import type { PlayerHandle } from "./Player";

/**
 * The timeline editor's right-click menus, each opened at the pointer: a clip's (what the Inspector offers on it), a
 * clip's audio strip and the music's, a pinned frame's, the range's; and what a clip's menu says of it at its head.
 */
export function useEditorMenus(clips: Clip[], player: RefObject<PlayerHandle | null>) {
  // the right-click menu of a clip: what the Inspector offers on it, at the pointer
  const clipMenu = useMenu<Clip>();
  /** Right-click on a clip's audio strip and on the music strip: what the clip panel's sound section and the music panel do, in place. */
  const soundMenu = useMenu<Clip>();
  /** A pinned frame's menu, opened on the track: the clip and which of its frames. */
  const pinMenu = useMenu<{ clip: Clip; where: PinWhere }>();
  const musicMenu = useMenu<true>();
  const rangeMenu = useMenu<true>();
  /** Where the playhead stands on a clip, when it stands on this one. */
  const onClip = (c: Clip) => {
    const here = player.current?.where();
    return here && here.clip.id === c.id ? here : null;
  };
  /** The head of a clip's menu: "Clip 3", its length and which take plays, the picture it shows. */
  const clipHead = (c: Clip): MenuHead => {
    const n = clips.findIndex((x) => x.id === c.id) + 1;
    const take = c.take && c.takes.length > 1 ? `take ${c.takes.findIndex((x) => x.id === c.take!.id) + 1} of ${c.takes.length}` : null;
    return {
      title: `Clip ${n}`,
      thumb: c.take?.asset.id ?? c.still?.id ?? c.pictures[0]?.asset.id,
      sub: headLine(c.kind === "still" ? "Still" : "Video", <span className="font-mono">{mmss(c.lengthMs)}</span>, take),
    };
  };
  return { clipMenu, soundMenu, pinMenu, musicMenu, rangeMenu, onClip, clipHead };
}
