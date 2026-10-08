import type { ReactNode } from "react";
import { WandSparkles } from "lucide-react";
import type { Look, RecipeInfo } from "./api";
import { mainTextOf } from "./RecipeForm";
import { Snippets, TickedSnippets } from "./Snippets";
import { Button } from "./ui";

/**
 * The helpers that sit above a form's text: the designer, and snippets (bits of text kept under a
 * name: ticked, they are added to what is written each time something is made). The designer's panel
 * itself lives in Designer.tsx, a chunk fetched when it opens; this stays in the forms.
 */
export function WritingHelp({ recipe, text, look, onLook, onInsert, onDesigner, head }: {
  recipe: RecipeInfo;
  /** What the main text box holds now, to keep as a snippet. */
  text: string;
  /** The ticked snippets are part of the look, with who is in it. */
  look: Look | null;
  onLook(look: Look): void;
  onInsert(text: string): void;
  onDesigner(): void;
  /** What the row starts with (the Prompt head of the Create panel); the buttons then go to its end. */
  head?: ReactNode;
}) {
  const main = mainTextOf(recipe);
  if (main?.type !== "prompt") return null;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        {head}
        {head && <span className="grow" />}
        <Button size="sm" onClick={onDesigner}><WandSparkles size={13} /> Designer</Button>
        <Snippets style={main.style} look={look} onLook={onLook} text={text} onInsert={onInsert} />
      </div>
      <TickedSnippets look={look} onLook={onLook} />
    </div>
  );
}
