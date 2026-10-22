import { describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import type { FamilyInfo, Job, MachineState, RecipeInfo, RecipeStatus } from "../../src/api";
import { Form } from "../../src/RecipeForm";
import { ModelField, useWaitsOn } from "../../src/fields/FileSelect";
import { useSettings, useSetup } from "../../src/data";
import { WaitingList } from "../../src/screens/queue/WaitingList";
import { fakeApi } from "./fakeApi";
import { draw } from "./render";

/**
 * What a waiting render says it waits for, with what it can do about it: its node packs (Install and restart, Run without
 * an option's pack), a family's official file on the user's own ComfyUI (Download, with downloads and lookups off: the
 * press is the consent; Look again for a file put in by hand); and the form's greyed official file, offered with its Download.
 */

const OFFICIAL = { file: "zz-test-base.safetensors", url: "https://huggingface.co/zz-test/base/resolve/main/zz-test-base.safetensors" };
const family = { id: "zz", name: "ZZ", slots: [{ id: "checkpoint", folder: "checkpoints", get: OFFICIAL }] } as unknown as FamilyInfo;
const own = { id: "m1", name: "", url: "http://127.0.0.1:8188", dir: "", takes: "all", packs: "ask", families: {} };
const job = (over: Partial<Job>): Job => ({ id: "j1", recipe: "zz.picture", label: "zz-test picture", status: "queued", kind: "render", estimateMs: 30_000, createdAt: new Date().toISOString(), ...over }) as unknown as Job;

function serve() {
  // downloads and lookups off, as on a new install
  fakeApi.on("GET /settings", { machines: [own], hasRunpodKey: false, downloadModels: false, civitaiLookups: false });
  fakeApi.on("GET /recipes", { families: [family], recipes: [] });
  fakeApi.on("GET /downloads", { on: false, items: [], manager: { found: false }, via: "afflatus" });
  fakeApi.on("POST /downloads", { id: "d1", file: OFFICIAL.file, folder: "checkpoints", status: "starting" });
  fakeApi.on("POST /setup/rescan", { comfy: { online: true }, recipes: [], lists: [] });
}

describe("a waiting render's node packs", () => {
  it("offers Install and restart, and Run without for an option's pack", async () => {
    serve();
    const onPacks = vi.fn();
    const w = job({ packs: { machine: "m1", packs: [{ name: "zz-test-pack", without: "its cache" }], state: "ask" } });
    const { user } = draw(<WaitingList waiting={[w]} running={null} onOrder={() => {}} onRemove={() => {}} onPacks={onPacks} />);
    // short words that fit at 1100 px, the pack named in the tip
    const said = await screen.findByText("waits for a node pack");
    expect(said.getAttribute("data-tip")).toMatch(/zz-test-pack/);
    await user.click(screen.getByRole("button", { name: "Install and restart" }));
    expect(onPacks).toHaveBeenLastCalledWith("j1", "install", ["zz-test-pack"]);
    await user.click(screen.getByRole("button", { name: "Run without its cache" }));
    expect(onPacks).toHaveBeenLastCalledWith("j1", "without", ["zz-test-pack"]);
  });

  it("leaves Install alone when a pack cannot be done without", async () => {
    serve();
    const w = job({ packs: { machine: "m1", packs: [{ name: "zz-test-gguf" }], state: "ask" } });
    draw(<WaitingList waiting={[w]} running={null} onOrder={() => {}} onRemove={() => {}} onPacks={() => {}} />);
    expect(await screen.findByRole("button", { name: "Install and restart" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Run without/ })).toBeNull();
  });
});

describe("a waiting render held by another job's node packs", () => {
  it("says it waits for its machine's ComfyUI to restart, and a pack that did not load says it is installed", async () => {
    serve();
    const machine = { id: "m1", name: "Studio PC", url: "", takes: "all", paused: false, online: true, locked: false, outside: null, rented: null, model: null, pace: null, running: null, packsHold: true } as unknown as MachineState;
    const held = job({ id: "j2", machine: "m1", label: "zz-test held" });
    const unloaded = job({ id: "j3", machine: "m1", packs: { machine: "m1", packs: [{ name: "zz-test-pack" }], state: "failed", unloaded: true, error: "installed, but ComfyUI did not load it" } });
    draw(<WaitingList waiting={[held, unloaded]} running={null} machines={[machine]} onOrder={() => {}} onRemove={() => {}} />);
    expect(await screen.findByText(/waits: Studio PC's ComfyUI restarts for a node pack/)).toBeTruthy();
    expect(screen.getAllByText(/restarts for a node pack/)).toHaveLength(1);
    expect(screen.getByText(/zz-test-pack installed, not loaded/)).toBeTruthy();
  });
});

describe("a waiting render's official file on the user's own ComfyUI", () => {
  it("offers its Download with downloads and lookups off, and Look again reads that machine's folders", async () => {
    serve();
    const w = job({ fetch: { m1: { files: [{ file: OFFICIAL.file, folder: "checkpoints", url: OFFICIAL.url }], ms: 0 } } } as Partial<Job>);
    const { user } = draw(<WaitingList waiting={[w]} running={null} onOrder={() => {}} onRemove={() => {}} />);
    expect(await screen.findByText(/Waits for 1 file on your ComfyUI/)).toBeTruthy();
    // never a wait with no button: the family's own file is downloaded on a press
    await user.click(await screen.findByRole("button", { name: /Download/ }));
    await waitFor(() => expect(fakeApi.calls("POST", "/downloads").map((c) => c.body)).toContainEqual({ file: OFFICIAL.file, folder: "checkpoints", url: OFFICIAL.url, machine: "m1" }));
    await user.click(screen.getByRole("button", { name: "Look again" }));
    await waitFor(() => expect(fakeApi.calls("POST", "/setup/rescan").map((c) => c.path)).toEqual(["/setup/rescan?machine=m1"]));
  });
  it("offers it too where the job wants it in another folder than its family's (a shipped preset's checkpoint loaded as a diffusion model), as the server takes it", async () => {
    serve();
    const w = job({ fetch: { m1: { files: [{ file: OFFICIAL.file, folder: "diffusion_models", url: OFFICIAL.url }], ms: 0 } } } as Partial<Job>);
    const { user } = draw(<WaitingList waiting={[w]} running={null} onOrder={() => {}} onRemove={() => {}} />);
    await user.click(await screen.findByRole("button", { name: /Download/ }));
    await waitFor(() => expect(fakeApi.calls("POST", "/downloads").map((c) => c.body)).toContainEqual({ file: OFFICIAL.file, folder: "diffusion_models", url: OFFICIAL.url, machine: "m1" }));
  });
  it("offers it too in a sub-folder as ComfyUI on Windows names it, with a backslash", async () => {
    serve();
    const file = `SDXL\\${OFFICIAL.file}`;
    const w = job({ fetch: { m1: { files: [{ file, folder: "checkpoints", url: OFFICIAL.url }], ms: 0 } } } as Partial<Job>);
    const { user } = draw(<WaitingList waiting={[w]} running={null} onOrder={() => {}} onRemove={() => {}} />);
    await user.click(await screen.findByRole("button", { name: /Download/ }));
    await waitFor(() => expect(fakeApi.calls("POST", "/downloads").map((c) => c.body)).toContainEqual({ file, folder: "checkpoints", url: OFFICIAL.url, machine: "m1" }));
  });
});

describe("a model field's official files not here", () => {
  it("lists them greyed after the user's own, and the one picked offers its Download", async () => {
    serve();
    fakeApi.on("GET /setup", { comfy: { online: true }, recipes: [], lists: [] });
    fakeApi.on("GET /official-sizes", { sizes: { [OFFICIAL.url]: 7 * 2 ** 30 }, asking: false });
    const { user } = draw(<ModelField id="ckpt" spec={{ label: "Checkpoint", folder: "checkpoints" }} value={OFFICIAL.file} options={["zz-test-mine.safetensors"]} family={family} onChange={() => {}} />);
    expect(await screen.findByText(/1 on your ComfyUI · 1 official not here/)).toBeTruthy();
    const under = within((await screen.findByText(/Not on your ComfyUI/)).parentElement!);
    await waitFor(() => expect(under.getByText(/7(\.0)? GB/)).toBeTruthy());
    await user.click(under.getByRole("button", { name: /Download/ }));
    await waitFor(() => expect(fakeApi.calls("POST", "/downloads").map((c) => c.body)).toContainEqual({ file: OFFICIAL.file, folder: "checkpoints", url: OFFICIAL.url }));
  });
});

describe("a model field's official file kept in a sub-folder of the user's own", () => {
  it("is on the ComfyUI, not greyed as not here: the server takes it there by its name", async () => {
    serve();
    fakeApi.on("GET /setup", { comfy: { online: true }, recipes: [], lists: [] });
    fakeApi.on("GET /official-sizes", { sizes: {}, asking: false });
    draw(<ModelField id="ckpt" spec={{ label: "Checkpoint", folder: "checkpoints" }} value={`Base\\${OFFICIAL.file}`} options={[`Base\\${OFFICIAL.file}`]} family={family} onChange={() => {}} />);
    expect(await screen.findByText(/^1 on your ComfyUI$/)).toBeTruthy();
    expect(screen.queryByText(/official not here/)).toBeNull();
  });

  it("is not a download Generate waits for", async () => {
    serve();
    fakeApi.on("GET /setup", { comfy: { online: true }, recipes: [], lists: [] });
    const recipe = { id: "zz.picture", family: "zz", title: "zz-test picture", inputs: [{ id: "ckpt", type: "model", label: "Checkpoint", folder: "checkpoints", slot: "checkpoint" }] } as unknown as RecipeInfo;
    const status = { id: "zz.picture", ready: true, missingNodes: [], missingSlots: [], emptyInputs: [], missingFiles: [], missing: [], problems: [], limitedBy: [], options: { ckpt: [`Base\\${OFFICIAL.file}`] } } as RecipeStatus;
    const missing = { ...status, options: { ckpt: ["zz-test-mine.safetensors"] } };
    function Says({ listed }: { listed: RecipeStatus }) {
      const waitsOn = useWaitsOn(recipe, listed, family);
      const settings = useSettings();
      const setup = useSetup();
      return <span>{settings.data && setup.data ? waitsOn({ ckpt: OFFICIAL.file }) ?? "goes at once" : "reading"}</span>;
    }
    draw(<><Says listed={status} /><Says listed={missing} /></>);
    expect(await screen.findByText("goes at once")).toBeTruthy();
    expect(await screen.findByText("waits for the download")).toBeTruthy();
  });
});

describe("a form's model value that its ComfyUI lacks", () => {
  const recipe = { id: "zz.picture", family: "zz", title: "zz-test picture", inputs: [{ id: "ckpt", type: "model", label: "Checkpoint", folder: "checkpoints" }] } as unknown as RecipeInfo;
  const status = { id: "zz.picture", ready: true, missingNodes: [], missingSlots: [], emptyInputs: [], missingFiles: [], missing: [], problems: [], limitedBy: [], options: { ckpt: ["zz-test-mine.safetensors"] } } as RecipeStatus;
  // drawn with its Model part opened, where the field and the note are
  const drawn = async (value: string, listed = status.options.ckpt!) => {
    const { user } = draw(<Form recipe={recipe} status={{ ...status, options: { ckpt: listed } }} stored={{ ckpt: value }} onChange={() => {}} onClear={() => {}} />);
    await user.click((await screen.findAllByRole("button", { name: /Model/ }))[0]!);
  };

  it("is said missing in a sub-folder the family's file is not in, as the field and Generate see it (not passed by its bare name)", async () => {
    serve();
    await drawn(`SDXL/${OFFICIAL.file}`);
    expect(await screen.findByText(/ComfyUI does not have/)).toBeTruthy();
  });

  it("is the family's own file at its path whatever the slash: offered with its Download, not said missing", async () => {
    serve();
    fakeApi.on("GET /setup", { comfy: { online: true }, recipes: [], lists: [] });
    await drawn(OFFICIAL.file);
    expect(await screen.findByText(/Not on your ComfyUI/)).toBeTruthy();
    expect(screen.queryByText(/ComfyUI does not have/)).toBeNull();
  });

  it("is the family's file in its sub-folder with the other slash (ComfyUI on Windows): offered with its Download too", async () => {
    serve();
    fakeApi.on("GET /setup", { comfy: { online: true }, recipes: [], lists: [] });
    const sub = { file: "zz/zz-test-base.safetensors", url: OFFICIAL.url };
    fakeApi.on("GET /recipes", { families: [{ ...family, slots: [{ id: "checkpoint", folder: "checkpoints", get: sub }] }], recipes: [] });
    await drawn("zz\\zz-test-base.safetensors");
    expect(await screen.findByText(/Not on your ComfyUI/)).toBeTruthy();
    expect(screen.queryByText(/ComfyUI does not have/)).toBeNull();
  });

  it("is not said missing when ComfyUI lists it in another sub-folder or with the other slash, as the server finds it (an imported workflow's model)", async () => {
    serve();
    fakeApi.on("GET /setup", { comfy: { online: true }, recipes: [], lists: [] });
    await drawn("SDXL/zz-test-mine.safetensors", ["SDXL\\zz-test-mine.safetensors"]);
    expect(await screen.findByText(/1 on your ComfyUI/)).toBeTruthy();
    expect(screen.queryByText(/ComfyUI does not have/)).toBeNull();
  });

  it("is said missing still when no listed file has its name", async () => {
    serve();
    fakeApi.on("GET /setup", { comfy: { online: true }, recipes: [], lists: [] });
    await drawn("SDXL/zz-test-other.safetensors", ["SDXL\\zz-test-mine.safetensors"]);
    expect(await screen.findByText(/ComfyUI does not have/)).toBeTruthy();
  });
});
