import { useState } from "react";

/**
 * What is selected and open in the timeline editor (useTimelineEditor): the clip selected, the clips picked to render
 * together, and which panel the column shows (a clip's, the music's, a join's, the source's, a recording's). Opening one
 * closes the others.
 */
export function useEditorPanels() {
  const [selected, setSelected] = useState<string | null>(null);
  /** The clips picked with Ctrl + click on the track, to render together. */
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [musicOpen, setMusicOpen] = useState(false);
  /** The clip whose join with the clip before is open in the column (its dot on the track was clicked). */
  const [joinOpen, setJoinOpen] = useState<string | null>(null);
  /** The source lane is open in the column. */
  const [sourceOpen, setSourceOpen] = useState(false);
  /** The recording open on the stage and in the column (its band on the Audio row clicked): its asset's id. */
  const [recordingOpen, setRecordingOpen] = useState<string | null>(null);
  /** A clip selected, its panel open in place of the music's. */
  const select = (clip: string | null) => {
    setSelected(clip);
    setMusicOpen(false);
    setJoinOpen(null);
    setSourceOpen(false);
    setRecordingOpen(null);
  };
  /** The source lane, opened in the column: no clip selected meanwhile. */
  const openSource = () => {
    setSelected(null);
    setMusicOpen(false);
    setJoinOpen(null);
    setRecordingOpen(null);
    setSourceOpen(true);
  };
  /** A recording opened as the source is: its stage and its panel, no clip selected meanwhile. */
  const openRecording = (asset: string) => {
    setSelected(null);
    setMusicOpen(false);
    setJoinOpen(null);
    setSourceOpen(false);
    setRecordingOpen(asset);
  };
  /** The join before a clip, opened in the column: the clip is selected with it. */
  const openJoin = (clip: string) => {
    setSelected(clip);
    setMusicOpen(false);
    setRecordingOpen(null);
    setJoinOpen(clip);
  };
  return { selected, setSelected, picked, setPicked, musicOpen, setMusicOpen, joinOpen, setJoinOpen, sourceOpen, setSourceOpen, recordingOpen, setRecordingOpen, select, openSource, openRecording, openJoin };
}
