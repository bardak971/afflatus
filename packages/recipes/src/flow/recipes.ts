import type { Recipe } from "@afflatus/core";
import { flowFixFace, type FlowFixFace } from "./fix-face";
import { flowKit, type FlowSpec } from "./kit";
import { flowOutpaint, type FlowOutpaint } from "./outpaint";
import { flowPaintOver, type FlowPaintOver } from "./paint-over";
import { flowPicture, type FlowPicture } from "./picture";
import { flowRedraw, type FlowRedraw } from "./redraw";
import { flowSharper, type FlowSharper } from "./sharper";

export { flowKit, type FlowBase, type FlowSpec } from "./kit";

/** The six operations of a picture model, from what is said about it once (see FlowSpec). */
export function flowRecipes(spec: FlowSpec): { picture: Recipe<FlowPicture>; redraw: Recipe<FlowRedraw>; paintOver: Recipe<FlowPaintOver>; outpaint: Recipe<FlowOutpaint>; sharper: Recipe<FlowSharper>; fixFace: Recipe<FlowFixFace> } {
  const kit = flowKit(spec);
  // Turbo's LoRA asked of the machine for each of them (kit.turboNeeds)
  const turbo = <T extends Recipe<any>>(r: T): T => ({ ...r, needsWith: kit.turboNeeds });
  return {
    picture: turbo(flowPicture(spec, kit)),
    redraw: turbo(flowRedraw(spec, kit)),
    paintOver: turbo(flowPaintOver(spec, kit)),
    outpaint: turbo(flowOutpaint(spec, kit)),
    sharper: turbo(flowSharper(spec, kit)),
    fixFace: turbo(flowFixFace(spec, kit)),
  };
}
