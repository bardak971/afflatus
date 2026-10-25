import { describe, expect, it } from "vitest";
import { installLogSaid } from "../src/podPacks";

const entries = (...m: string[]) => m.map((x) => ({ m: x }));

describe("installLogSaid (why Manager failed a pack's install, from ComfyUI's log; card #47)", () => {
  it("takes the failed requirement's own pack, not another pack's failure in the same batch", () => {
    const log = entries(
      "## ComfyUI-Manager: EXECUTE => ['/usr/bin/python3', '-m', 'pip', 'install', 'mediapipe']\n",
      "[!] ERROR: No matching distribution found for mediapipe\n",
      "install script failed: comfyui_controlnet_aux\n",
      "## ComfyUI-Manager: EXECUTE => ['/usr/bin/python3', 'install.py']\n",
      "[!] Traceback (most recent call last):\n",
      "[!] RuntimeError: no CUDA driver\n",
      "install script failed: comfyui_nvidia_rtx_nodes@1.0.2\n",
    );
    expect(installLogSaid(log, "comfyui_controlnet_aux")).toBe("pip install mediapipe: ERROR: No matching distribution found for mediapipe");
    // an install.py with no "ERROR:" line: its last line says it
    expect(installLogSaid(log, "comfyui_nvidia_rtx_nodes")).toBe("its install.py: RuntimeError: no CUDA driver");
  });

  it("reads uv's error lines too (Manager's use_uv)", () => {
    const log = entries(
      "## ComfyUI-Manager: EXECUTE => ['/usr/bin/python3', '-m', 'uv', 'pip', 'install', 'sam2']\n",
      "[!] ",
      "  × No solution found when resolving dependencies:\n",
      "[!]   ╰─▶ Because torch==2.10.0+cu130 is unavailable …\n",
      "install script failed: comfyui-impact-pack\n",
    );
    expect(installLogSaid(log, "Comfyui-Impact-Pack")).toBe("pip install sam2: × No solution found when resolving dependencies:; ╰─▶ Because torch==2.10.0+cu130 is unavailable …");
  });

  it("says nothing when the log does not: Manager on Windows runs install scripts at ComfyUI's next start", () => {
    expect(installLogSaid(entries("Installation reserved: comfyui-impact-pack\n", "After restarting ComfyUI, please refresh the browser.\n"), "comfyui-impact-pack")).toBeNull();
    expect(installLogSaid(entries("install script failed: comfyui-impact-pack-extra\n"), "comfyui-impact-pack")).toBeNull();
    expect(installLogSaid([], "x", true)).toBeNull();
  });
});
