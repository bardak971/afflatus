import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { Yours } from "../../src/findModels/Yours";
import { FileWhere } from "../../src/FileWhere";
import { fakeApi } from "./fakeApi";
import { draw } from "./render";

/**
 * Find models › Yours asks where its files are on disk in one request (card #74): it made one per row, up to 80 each time
 * the list was opened. Each row keeps its own query (the command bar reads the same cache); the page names files, never paths.
 */

const at = (file: string) => `C:\\ComfyUI\\models\\loras\\${file}`;
type Asked = { files: Array<{ folder: string; file: string }>; machine?: string };
/** The server's /where: each file named is in ComfyUI's own loras folder. */
const answerWhere = () => fakeApi.on("POST /model-files/where", ({ body }: { body: unknown }) => ({ known: true, reveal: true, places: (body as Asked).files.map((f) => [{ path: at(f.file), kind: "own" }]) }));

describe("where Yours's files are", () => {
  it("asks for every row's places in one request, and shows each row its own", async () => {
    const files = Array.from({ length: 12 }, (_, i) => ({ file: `zz-test-${i}.safetensors`, folder: "loras", size: 1, via: null }));
    fakeApi.on("GET /model-sets/search", { presets: [], families: [], files });
    answerWhere();
    draw(<Yours words="zz-test" onWords={() => {}} picked={new Set()} onPick={() => {}} />);
    for (const f of files) expect(await screen.findByText(at(f.file))).toBeTruthy();
    const asked = fakeApi.calls("POST", "/model-files/where");
    expect(asked).toHaveLength(1);
    expect(asked[0]!.body).toEqual({ files: files.map((f) => ({ folder: f.folder, file: f.file })) });
    expect(fakeApi.calls("GET", "/model-files/where")).toEqual([]);
  });

  it("sends one request per ComfyUI, each naming only its own files", async () => {
    answerWhere();
    draw(
      <>
        <FileWhere folder="loras" file="zz-test-a.safetensors" />
        <FileWhere folder="loras" file="zz-test-b.safetensors" machine="m2" />
        <FileWhere folder="loras" file="zz-test-c.safetensors" />
      </>,
    );
    for (const f of ["a", "b", "c"]) expect(await screen.findByText(at(`zz-test-${f}.safetensors`))).toBeTruthy();
    expect(fakeApi.calls("POST", "/model-files/where").map((c) => c.body)).toEqual([
      { files: [{ folder: "loras", file: "zz-test-a.safetensors" }, { folder: "loras", file: "zz-test-c.safetensors" }] },
      { files: [{ folder: "loras", file: "zz-test-b.safetensors" }], machine: "m2" },
    ]);
  });

  it("sends a list longer than the server takes in parts of 200", async () => {
    answerWhere();
    const names = Array.from({ length: 250 }, (_, i) => `zz-test-${i}.safetensors`);
    draw(<>{names.map((file) => <FileWhere key={file} folder="loras" file={file} />)}</>);
    await waitFor(() => expect(screen.getByText(at(names.at(-1)!))).toBeTruthy());
    expect(fakeApi.calls("POST", "/model-files/where").map((c) => (c.body as Asked).files.length)).toEqual([200, 50]);
  });
});
