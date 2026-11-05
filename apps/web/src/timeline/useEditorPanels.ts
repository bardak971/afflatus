import { useEffect, useMemo, useState } from "react";
import type { Clip } from "../api";

/**
 * What is selected and open in the timeline editor (useTimelineEditor): the clip selected, the clips picked to render
 * together, and which panel the column shows (a clip's, the music's, a join's, the source's, a recording's). Opening one
 * closes the others.
 */
export function useEditorPanels() {
  const [selected, setSelected] = useState<string | null>(null);
  /** The clips picked with Ctrl + click on the track, to render together. */
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [musicOpen, setMusic] = useState(false);
  /** The clip whose join with the clip before is open in the column (its dot on the track was clicked). */
  const [joinOpen, setJoinOpen] = useState<string | null>(null);
  /** The source lane is open in the column. */
  const [sourceOpen, setSourceOpen] = useState(false);
  /** The recording open on the stage and in the column (its band on the Audio row clicked): its asset's id. */
  const [recordingOpen, setRecordingOpen] = useState<string | null>(null);
  /** A clip selected, its panel open in place of the music's. */
  const select = (clip: string | null) => {
    setSelected(clip);
    setMusic(false);
    setJoinOpen(null);
    setSourceOpen(false);
    setRecordingOpen(null);
  };
  /** The source lane, opened in the column: no clip selected meanwhile. */
  const openSource = () => {
    setSelected(null);
    setMusic(false);
    setJoinOpen(null);
    setRecordingOpen(null);
    setSourceOpen(true);
  };
  /** A recording opened as the source is: its stage and its panel, no clip selected meanwhile. */
  const openRecording = (asset: string) => {
    setSelected(null);
    setMusic(false);
    setJoinOpen(null);
    setSourceOpen(false);
    setRecordingOpen(asset);
  };
  /**
   * The music's panel opened or closed. Opened, it closes the recording, whose panel the column shows before it: a drop on
   * the music lane, Show music or the Overview's music button did nothing while one was open. The source's keeps the
   * column, as it did.
   */
  const setMusicOpen = (on: boolean) => {
    if (on) setRecordingOpen(null);
    setMusic(on);
  };
  /** The join before a clip, opened in the column: the clip is selected with it. */
  const openJoin = (clip: string) => {
    setSelected(clip);
    setMusic(false);
    setRecordingOpen(null);
    setJoinOpen(clip);
  };
  return { selected, setSelected, picked, setPicked, musicOpen, setMusicOpen, joinOpen, sourceOpen, setSourceOpen, recordingOpen, setRecordingOpen, select, openSource, openRecording, openJoin };
}

/**
 * The editor's selection, read by its parts in one piece (editorProps): the panels open (useEditorPanels), the picked clips
 * kept to those still on the timeline, and the clip selected as it stands on it.
 */
export function useEditorSelection(clips: Clip[]) {
  const { picked: pickedAll, setPicked, selected, ...panels } = useEditorPanels();
  // the picked clips still on the timeline: an Undo or a removal takes clips away under the pick, and Delete would send
  // ids no longer there (the whole removal refused), the header and the menus count them; dropped from the pick too, so
  // a Redo bringing one back does not bring it back picked
  const picked = useMemo(() => {
    const here = new Set(clips.map((c) => c.id));
    const kept = new Set([...pickedAll].filter((id) => here.has(id)));
    return kept.size === pickedAll.size ? pickedAll : kept;
  }, [pickedAll, clips]);
  useEffect(() => {
    if (picked !== pickedAll) setPicked(picked);
  }, [picked, pickedAll, setPicked]);
  /** A clip picked with Ctrl + click on the track, or let go when it was picked. */
  const togglePick = (id: string) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const current = clips.find((c) => c.id === selected) ?? null;
  return { ...panels, selected, picked, setPicked, togglePick, current };
}

/** What is selected and open in the editor (useEditorSelection). */
export type EditorSelection = ReturnType<typeof useEditorSelection>;
