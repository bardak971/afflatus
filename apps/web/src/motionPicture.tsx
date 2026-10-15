import { useState } from "react";
import type { ClipValue, InputSpec } from "@afflatus/core";
import { useFormTarget } from "./formTarget";
import { PictureMaker, usePictureSets } from "./pictureMaker";
import { Slider } from "./Slider";

/** A Motion transfer form: a picture that moves and a driving video of which a part is taken. */
export function motionSlots(inputs: readonly InputSpec[]): { picture: InputSpec; driving: Extract<InputSpec, { type: "clip" }> } | null {
  const picture = inputs.find((i) => i.type === "image" && i.role === "source");
  const driving = inputs.find((i): i is Extract<InputSpec, { type: "clip" }> => i.type === "clip" && i.role === "source" && Boolean(i.window));
  return picture && driving ? { picture, driving } : null;
}

/**
 * Under the Picture of a Motion transfer form whose driving video is chosen (SCAIL-2, Wan Animate 2, in Create): the picture
 * made for the user (pictureMaker.tsx), its frame chosen within the driving video's part, the cast's people offered as who
 * goes in. Shown while there is no Picture, and after one was made here (to pick another, or reroll).
 */
export function MakeFromDriving({ specs, values, current, onPick }: { specs: readonly InputSpec[]; values: Record<string, unknown>; current: string | null; onPick(asset: string): void }) {
  const target = useFormTarget((s) => s.target);
  const slots = motionSlots(specs);
  const driving = slots ? (values[slots.driving.id] as ClipValue | undefined) : undefined;
  const start = slots?.driving.window ? Number(values[slots.driving.window.start] ?? 0) : 0;
  const seconds = slots?.driving.window ? Number(values[slots.driving.window.seconds] ?? 5) : 5;
  const [at, setAt] = useState<number | null>(null);
  const made = usePictureSets((s) => (target?.draftId ? (s.of[`draft:${target.draftId}`]?.jobs.length ?? 0) > 0 : false));
  if (!slots || !driving || !target?.draftId || (current && !made)) return null;
  const frame = Math.max(start, Math.min(start + seconds, at ?? start));
  return (
    <PictureMaker
      keyId={`draft:${target.draftId}`}
      video={driving.asset}
      atMs={frame * 1000}
      name="Picture for Motion transfer"
      folder={target.folder}
      cast={target.look?.cast.map((c) => c.id)}
      current={current}
      onPick={onPick}
      frameControl={<Slider label="Frame" value={frame} min={start} max={start + seconds} step={0.1} unit=" s" onChange={setAt} />}
    />
  );
}
