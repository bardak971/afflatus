import type { ReactNode } from "react";
import type { InputSpec } from "@afflatus/core";
import { cx } from "../ui";
import { Heading, Part } from "./Part";

/** What a form will take, learned from this machine's own renders with the model; `over`: past where it slowed down before. */
export interface Estimate { text: string; pace: "usual" | "untested" | "over" }

/**
 * The Output part: the size, the length and the seed, the upscale pass with its tuning, the encoding, and
 * what it will take, learned from this machine's own renders with the model: nothing assumed about the card.
 */
export function OutputPart({ out, upscaling, encoding, summary, estimate, q, render, setting }: {
  out: InputSpec[];
  upscaling: InputSpec[];
  encoding: InputSpec[];
  summary: ReactNode;
  estimate: Estimate | null | undefined;
  q: string;
  /** A field as it is. */
  render(i: InputSpec): ReactNode;
  /** A field with a mark and a way back when it differs from what the model starts with. */
  setting(i: InputSpec): ReactNode;
}) {
  if (!out.length && !encoding.length && !upscaling.length) return null;
  return (
    <Part id="output" title="Output" summary={summary} warn={estimate?.pace === "over" ? "past your card's usual pace" : undefined} needs={Boolean(q)}>
      {out.map(render)}
      {/* the tuning of the upscale pass sits with the route that turns it on */}
      {upscaling.length > 0 && <Heading title="Upscale pass" note="the second sampling over the enlarged latent: how hard it re-samples, which upscaler, tiles and stretches" />}
      {upscaling.map(setting)}
      {encoding.length > 0 && <Heading title="Encode" note="frame rate, frame interpolation, compression" />}
      {encoding.map(setting)}
      {estimate && (
        <span className={cx("text-xs", estimate.pace === "over" ? "font-semibold text-warn-ink" : "text-ink-2")} data-tip="Learned from your own renders with this model on this machine: how long a step took at each size, and where the card stopped keeping its pace.">
          {estimate.text}
        </span>
      )}
    </Part>
  );
}
