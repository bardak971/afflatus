import type { Family, Recipe } from "@afflatus/core";
import { families as builtInFamilies, recipes as builtInRecipes } from "@afflatus/recipes";
import { familyOf, recipeFromWorkflow, workflowDef, type WorkflowDef } from "@afflatus/workflows";
import { now, OWNER, type Db } from "./db";

/** Who imported a workflow that waits for the user's approval: the MCP token, by id, and its name then. */
export interface Pending { token: string; name: string }

/** Said when a workflow an agent imported is rendered before the user approved it (queue.ts renderJob). */
export const waitingWords = (title: string) => `“${title}” was imported by an agent and waits for the user's approval: Studio › Workflows › Approve, in Afflatus. It renders from then on.`;

/** A workflow's recipe, built once as it was saved: what cannot be built is found here, not by every later reader. */
export function made(def: WorkflowDef): Recipe<any> {
  const recipe = recipeFromWorkflow(def);
  void recipe.files;
  return recipe;
}

/**
 * Everything Afflatus can make things with: the built-in recipes, plus one recipe per imported workflow.
 * The rest of the server asks here and never needs to know which kind a recipe is.
 */
export class Registry {
  private defs: WorkflowDef[] = [];
  private made: Recipe<any>[] = [];
  /** Saved workflows that could not be made into a recipe, with why: listed (to be changed or removed), never run. */
  private broken = new Map<string, string>();
  /** Workflows an agent imported that wait for the user's approval (Studio › Workflows), by id: the MCP token that imported each. */
  private waiting = new Map<string, Pending>();
  /** Called when the list changes (what ComfyUI can run has to be worked out again). */
  onChange: () => void = () => {};

  constructor(private readonly db: Db) {}

  /**
   * Read the saved workflows. One that no longer parses is skipped with a warning; one that cannot be made into a
   * recipe (its graph cannot be built) stays listed, with why, and is not offered: never fatal, one workflow does not
   * keep the server from starting.
   */
  async load(): Promise<void> {
    const rows = await this.db.selectFrom("workflows").select(["id", "def", "pending_token", "pending_name"]).orderBy("created_at").execute();
    this.defs = [];
    this.made = [];
    this.broken = new Map();
    this.waiting = new Map();
    for (const row of rows) {
      let parsed;
      try {
        parsed = workflowDef.safeParse(JSON.parse(row.def));
      } catch {
        parsed = null;
      }
      if (!parsed?.success) {
        console.warn(`[workflows] ${row.id} could not be read and is skipped`);
        continue;
      }
      this.defs.push(parsed.data);
      if (row.pending_token) this.waiting.set(parsed.data.id, { token: row.pending_token, name: row.pending_name ?? "" });
      try {
        this.made.push(made(parsed.data));
      } catch (err) {
        this.broken.set(parsed.data.id, (err as Error).message);
        console.warn(`[workflows] ${row.id} cannot be built and is not offered: ${(err as Error).message}`);
      }
    }
    this.onChange();
  }

  /** Why a saved workflow is not offered, when it is not. */
  problem(id: string): string | undefined {
    return this.broken.get(id);
  }

  /** The MCP token whose import of this workflow waits for the user's approval; undefined: the user's own, or approved. */
  pending(id: string): Pending | undefined {
    return this.waiting.get(id);
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

  /**
   * Keep a workflow. `by`: the MCP token whose call saved it: the workflow then waits for the user's approval, a new one or
   * one changed (an approved workflow an agent changes waits again). Left out (the user's own save), whether it waits stays
   * as it was: editing an agent's import in the editor is not approving it, Approve is.
   */
  async save(def: WorkflowDef, by?: Pending): Promise<void> {
    const json = JSON.stringify(def);
    const at = now();
    const waits = by ? { pending_token: by.token, pending_name: by.name } : {};
    await this.db
      .insertInto("workflows")
      .values({ id: def.id, owner_id: OWNER, def: json, created_at: at, updated_at: at, ...waits })
      .onConflict((oc) => oc.column("id").doUpdateSet({ def: json, updated_at: at, ...waits }))
      .execute();
    await this.load();
  }

  /** The user's approval of a workflow an agent imported: it renders from now on. False when there is no such workflow. */
  async approve(id: string): Promise<boolean> {
    const r = await this.db.updateTable("workflows").set({ pending_token: null, pending_name: null }).where("id", "=", id).executeTakeFirst();
    await this.load();
    return Number(r.numUpdatedRows) > 0;
  }

  async remove(id: string): Promise<boolean> {
    const r = await this.db.deleteFrom("workflows").where("id", "=", id).executeTakeFirst();
    await this.load();
    return Number(r.numDeletedRows) > 0;
  }
}
