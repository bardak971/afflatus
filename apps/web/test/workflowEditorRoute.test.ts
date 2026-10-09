import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { workflowEditHref } from "../src/bar/bridge";

// the routes App.tsx registers, read from its source: the screens are lazy and the router needs a browser
const app = readFileSync(join(__dirname, "../src/App.tsx"), "utf8");
const routes = [...app.matchAll(/<Route path="([^"]+)"/g)].map((m) => m[1]!);
// a route's pattern as wouter reads it: each :param is one segment, and the whole path must match
const matches = (route: string, path: string) => new RegExp(`^${route.replace(/:\w+/g, "[^/]+")}$`).test(path);

describe("the workflow editor's address", () => {
  it("is a saved workflow's id under /workflows, and App routes it to the editor", () => {
    expect(workflowEditHref("workflow.wan-i2v-2")).toBe("/workflows/workflow.wan-i2v-2/edit");
    expect(routes.filter((r) => matches(r, workflowEditHref("workflow.wan-i2v-2")))).toEqual(["/workflows/:id/edit"]);
    expect(app).toMatch(/<Route path="\/workflows\/:id\/edit" component=\{WorkflowEdit\} \/>/);
  });

  it("is /workflows/new for an import not saved yet, apart from the list's own address", () => {
    expect(routes.filter((r) => matches(r, "/workflows/new"))).toEqual(["/workflows/new"]);
    expect(app).toMatch(/<Route path="\/workflows\/new" component=\{WorkflowImport\} \/>/);
    expect(routes.filter((r) => matches(r, "/workflows"))).toEqual(["/workflows"]);
  });
});
