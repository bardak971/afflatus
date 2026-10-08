import type { Recipe } from "@afflatus/core";
import { flowFixFace, type FlowFixFace } from "./fix-face";
import { flowKit, type FlowSpec } from "./kit";
import { flowOutpaint, type FlowOutpaint } from "./outpaint";
import { flowPaintOver, type FlowPaintOver } from "./paint-over";
import { flowPicture, type FlowPicture } from "./picture";
import { flowRedraw, type FlowRedraw } from "./redraw";
import { flowSharper, type FlowSharper } from "./sharper";

export { flowKit, type FlowBase, type FlowKit, type FlowSpec } from "./kit";

/** The six operations of a picture model, from what is said about it once (see FlowSpec). */
export function flowRecipes(spec: FlowSpec): { picture: Recipe<FlowPicture>; redraw: Recipe<FlowRedraw>; paintOver: Recipe<FlowPaintOver>; outpaint: Recipe<FlowOutpaint>; sharper: Recipe<FlowSharper>; fixFace: Recipe<FlowFixFace> } {
  const kit = flowKit(spec);
  return {
    picture: flowPicture(spec, kit),
    redraw: flowRedraw(spec, kit),
    paintOver: flowPaintOver(spec, kit),
    outpaint: flowOutpaint(spec, kit),
    sharper: flowSharper(spec, kit),
    fixFace: flowFixFace(spec, kit),
  };
}
