import { useFormTarget } from "../formTarget";
import { useStudio } from "../store";
import { useRegionsStage } from "./useRegionsStage";

/**
 * The form's Box or Text picked (the Regions card): the Stage of the draft comes into view with that tool in hand, its frame
 * when it has made nothing yet, else the boxes over the picture it shows.
 */
export function drawRegions(tool: "box" | "text"): void {
  const draft = useFormTarget.getState().target?.draftId;
  const studio = useStudio.getState();
  studio.set({ scope: "draft", displays: { ...studio.displays, draft: "Stage" } });
  if (draft) useRegionsStage.getState().show(draft, tool);
  else useRegionsStage.getState().setTool(tool);
}
