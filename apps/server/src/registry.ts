import type { Family, Recipe } from "@afflatus/core";
import { families as builtInFamilies, recipes as builtInRecipes } from "@afflatus/recipes";
import { familyOf, recipeFromWorkflow, workflowDef, type WorkflowDef } from "@afflatus/workflows";
import { now, OWNER, type Db } from "./db";

/**
 * Everything Afflatus can make things with: the built-in recipes, plus one recipe per imported workflow.
 * The rest of the server asks here and never needs to know which kind a recipe is.
 */
export class Registry {
  private defs: WorkflowDef[] = [];
  private made: Recipe<any>[] = [];
  /** Called when the list changes (what ComfyUI can run has to be worked out again). */
  onChange: () => void = () => {};

  constructor(private readonly db: Db) {}

  /** Read the saved workflows. One that no longer parses is skipped with a warning, not fatal. */
  async load(): Promise<void> {
    const rows = await this.db.selectFrom("workflows").select(["id", "def"]).orderBy("created_at").execute();
    this.defs = [];
    for (const row of rows) {
      const parsed = workflowDef.safeParse(JSON.parse(row.def));
      if (parsed.success) this.defs.push(parsed.data);
      else console.warn(`[workflows] ${row.id} could not be read and is skipped`);
    }
    this.made = this.defs.map(recipeFromWorkflow);
    this.onChange();
  }

  recipes(): Recipe<any>[] {
    return [...builtInRecipes, ...this.made];
  }
  recipe(id: string): Recipe<any> | undefined {
    return this.recipes().find((r) => r.id === id);
  }
  families(): Family[] {
    const all = [...builtInFamilies];
    for (const def of this.defs) {
      const f = familyOf(def);
      if (!all.some((x) => x.id === f.id)) all.push(f);
    }
    return all;
  }
  family(id: string): Family | undefined {
    return this.families().find((f) => f.id === id);
  }

  workflows(): WorkflowDef[] {
    return this.defs;
  }
  workflow(id: string): WorkflowDef | undefined {
    return this.defs.find((d) => d.id === id);
  }

  async save(def: WorkflowDef): Promise<void> {
    const json = JSON.stringify(def);
    const at = now();
    await this.db
      .insertInto("workflows")
      .values({ id: def.id, owner_id: OWNER, def: json, created_at: at, updated_at: at })
      .onConflict((oc) => oc.column("id").doUpdateSet({ def: json, updated_at: at }))
      .execute();
    await this.load();
  }

  async remove(id: string): Promise<boolean> {
    const r = await this.db.deleteFrom("workflows").where("id", "=", id).executeTakeFirst();
    await this.load();
    return Number(r.numDeletedRows) > 0;
  }
}
