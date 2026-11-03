"""The pod image's two Dockerfiles: the base (base/Dockerfile: torch, ComfyUI, the packs) and the top on it (Dockerfile).
The top's build context: every file it copies from the repository is let in by Dockerfile.dockerignore, which shuts out all
else. A script added to the image but not to that list fails the image's build on GitHub, after its tag is pushed
(pod-v0.1.18: died.py); here it fails before. The base copies its locks only, and carries what the top's build checks it by.
"""

import importlib.util
import json
import os
import re
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
POD = os.path.dirname(HERE)
CUDAS = ("cu130", "cu128")


def read(name):
    with open(os.path.join(POD, name), encoding="utf-8") as f:
        return f.read()


def copied(text=None):
    """The repository paths the Dockerfile's COPY lines take: every source of each (not those from another stage, --from=),
    lines continued with a backslash read as one, the JSON form as well as the plain one."""
    text = read("Dockerfile") if text is None else text
    out = []
    for line in re.sub(r"\\\n", " ", text).splitlines():
        found = re.match(r"^\s*COPY\s+(.*)$", line, re.I)
        if not found:
            continue
        rest = found.group(1).strip()
        flags = re.findall(r"--\S+", rest)
        if any(f.startswith("--from") for f in flags):
            continue
        rest = re.sub(r"--\S+\s*", "", rest).strip()
        parts = json.loads(rest) if rest.startswith("[") else rest.split()
        out.extend(parts[:-1])
    return out


def let_in():
    """What the ignore file lets in after its "*": its "!" lines."""
    return [line[1:].strip() for line in read("Dockerfile.dockerignore").splitlines() if line.startswith("!")]


BASE = os.path.join("base", "Dockerfile")


class RtxVsr(unittest.TestCase):
    def test_the_rtx_route_has_nvidias_runtime_pinned_by_its_hash(self):
        # DaSiWa's RTX node imports nvvfx when it runs: the image without it failed every RTX VSR finish on a pod
        found = re.search(r'pip install --no-deps "nvidia-vfx @ (https://pypi\.nvidia\.com/\S+\.whl)#sha256=([0-9a-f]{64})"', read(BASE))
        self.assertIsNotNone(found, "the Dockerfile installs nvidia-vfx from NVIDIA's index, pinned by its sha256")
        self.assertIn("cp312", found.group(1), "the wheel is for the image's Python 3.12")


class Context(unittest.TestCase):
    def test_every_file_the_image_copies_is_in_its_build_context(self):
        allowed = let_in()
        for path in copied():
            self.assertTrue(any(path == a or path.startswith(a.rstrip("/") + "/") for a in allowed), f"{path} is copied by the Dockerfile but shut out by Dockerfile.dockerignore")

    def test_it_reads_the_copies(self):
        self.assertIn("deploy/runpod/died.py", copied())
        self.assertIn("comfy-nodes/afflatus-nodes", copied())

    def test_it_reads_every_form_of_copy(self):
        text = (
            "COPY a.py b.py /opt/x/\n"
            "COPY --chown=1000 c.sh \\\n    d.sh /opt/y/\n"
            'COPY ["e.json", "/opt/z/"]\n'
            "COPY --from=build /wheels /wheels\n"
        )
        self.assertEqual(copied(text), ["a.py", "b.py", "c.sh", "d.sh", "e.json"])


def lock_tool():
    spec = importlib.util.spec_from_file_location("base_lock", os.path.join(POD, "base_lock.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def lock_lines(cuda):
    """A lock's packages: one line each, its first line (what it was made from) left out."""
    return [line for line in read(os.path.join("base", f"requirements-{cuda}.lock")).splitlines() if line and not line.startswith("#")]


def joined(text):
    return re.sub(r"\\\n", " ", text)


class Base(unittest.TestCase):
    def test_it_copies_its_locks_only(self):
        # its build context is its own folder, which holds the Dockerfile and its locks only
        self.assertEqual(copied(read(BASE)), ["requirements-${TORCH_CUDA}.lock"])
        self.assertEqual(sorted(os.listdir(os.path.join(POD, "base"))), ["Dockerfile", "requirements-cu128.lock", "requirements-cu130.lock"])

    def test_both_workflows_hash_the_same_files(self):
        # the label the base is built with, and what the top's build compares it with: the Dockerfile and both locks
        hashed = "cat deploy/runpod/base/Dockerfile deploy/runpod/base/requirements-cu128.lock deploy/runpod/base/requirements-cu130.lock | tr -d '\\r' | sha256sum"
        for workflow in ("pod-base-image.yml", "pod-image.yml"):
            text = read(os.path.join("..", "..", ".github", "workflows", workflow))
            self.assertIn(hashed, text, workflow)
            self.assertNotIn("< deploy/runpod/base/Dockerfile | sha256sum", text, workflow)

    def test_it_says_its_comfyui_to_the_top(self):
        # the top's registry_cache.py asks Manager's list for this ComfyUI
        text = read(BASE)
        self.assertRegex(text, r'(?m)^ARG COMFYUI_VERSION=v\d+\.\d+\.\d+$')
        self.assertRegex(text, r'(?m)^ENV AFFLATUS_COMFYUI_VERSION="\$\{COMFYUI_VERSION\}"$')

    def test_it_is_labelled_with_the_hash_its_workflow_gives(self):
        # pod-image.yml builds the top only on a base made from this commit's file
        self.assertRegex(read(BASE), r'afflatus\.base-dockerfile-sha256="\$\{BASE_DOCKERFILE_SHA256\}"')
        self.assertRegex(read(BASE), r'afflatus\.cuda="\$\{TORCH_CUDA\}"')

    def test_it_leaves_out_what_no_pod_shows_in_the_layer_that_installs_it(self):
        # the templates' media and the nodes' docs (~535 MB unpacked at every boot): gone in the same RUN, or the layer
        # holds them all the same; the templates' index and workflows stay, or ComfyUI logs an error at each start
        run = next(r for r in joined(read(BASE)).splitlines() if r.startswith("RUN ") and "-r /tmp/rest.lock" in r)
        for media in ("api", "video", "image", "other", "assets-01", "assets-02"):
            self.assertIn(f"comfyui-workflow-templates-media-{media}", run)
        self.assertIn("comfyui-embedded-docs", run)
        self.assertIn("import comfyui_workflow_templates, comfyui_workflow_templates_json", run)

    def test_its_layers_are_zstd(self):
        # a pull is its host unpacking the layers: zstd, forced on the python image's layers too; the top keeps them in an
        # OCI manifest, the only one that names zstd
        base = read(os.path.join("..", "..", ".github", "workflows", "pod-base-image.yml"))
        self.assertRegex(base, r"(?m)^\s+outputs: type=image,push=\$\{\{ env\.PUBLISH == 'true' \}\},compression=zstd,force-compression=true,oci-mediatypes=true$")
        self.assertNotRegex(base, r"(?m)^\s+push: \$")
        top = read(os.path.join("..", "..", ".github", "workflows", "pod-image.yml"))
        self.assertRegex(top, r"(?m)^\s+outputs: type=image,push=\$\{\{ env\.PUBLISH == 'true' \}\},oci-mediatypes=true$")
        self.assertNotRegex(top, r"(?m)^\s+push: \$")

    def test_every_python_package_comes_from_the_lock_by_its_hash(self):
        # the 2026-11-02 review, L10: nothing resolved at build time, nothing taken without its SHA-256
        text = joined(read(BASE))
        installs = [line for line in text.splitlines() if re.search(r"\bpip install\b", line)]
        self.assertTrue(installs)
        for line in installs:
            for each in re.findall(r"pip install[^&;']*", line):
                if "nvidia-vfx @" in each:
                    continue
                self.assertIn("--require-hashes", each, line)
                self.assertIn("--no-deps", each, line)
        self.assertNotRegex(text, r"pip install -c|-r requirements\.txt|torch-cuda\.txt")
        # every install of the lock is `locked <pattern>` or the rest of it
        patterns = re.findall(r"(?m)^RUN (?:.*&& )?locked '([^']+)'", text)
        rest = re.search(r"grep -vE '([^']+)' /base\.lock > /tmp/rest\.lock", text).group(1)
        self.assertGreaterEqual(len(patterns), 8)
        for cuda in CUDAS:
            for line in lock_lines(cuda):
                self.assertRegex(line, r"^[A-Za-z0-9_.-]+==\S+( --hash=sha256:[0-9a-f]{64})+$")
                # each package installed by exactly one step: a CUDA library left out by every pattern would be missing
                taken = [p for p in patterns if re.search(p, line)]
                if re.search(rest, line):
                    self.assertEqual(len(taken), 1, f"{cuda}: {line[:60]} is in no step, or in two")
                else:
                    self.assertEqual(taken, [], f"{cuda}: {line[:60]} is in a step and the rest")
            names = [line.split("==")[0] for line in lock_lines(cuda)]
            for wanted in ("torch", "comfyui-manager", "ultralytics", "insightface", "onnxruntime", "opencv-python", "segment-anything"):
                self.assertIn(wanted, names, cuda)
            self.assertNotIn("sam2", names)

    def test_its_locks_are_made_from_what_it_pins(self):
        # a commit or torch moved in the Dockerfile without the locks made again: they would install another's packages
        tool = lock_tool()
        args = tool.args_of(read(BASE))
        for cuda in CUDAS:
            first = read(os.path.join("base", f"requirements-{cuda}.lock")).splitlines()[0]
            self.assertEqual(first, tool.made_from(args), f"requirements-{cuda}.lock: run deploy/runpod/base_lock.py")
            torch = next(line for line in lock_lines(cuda) if line.startswith("torch=="))
            self.assertTrue(torch.startswith(f"torch=={args['TORCH_VERSION']}+{cuda} "))

    def test_the_lock_tool_reads_a_list_and_uvs_output(self):
        tool = lock_tool()
        self.assertEqual(tool.wanted("# x\ntorch\nnumpy>=1.25 # why\n\ngit+https://github.com/facebookresearch/sam2\n-r other.txt\n"), ["torch", "numpy>=1.25"])
        compiled = "a==1 \\\n    --hash=sha256:" + "0" * 64 + " \\\n    --hash=sha256:" + "1" * 64 + "\n    # via x\nb==2 \\\n    --hash=sha256:" + "2" * 64 + "\n"
        self.assertEqual(tool.one_line_each(compiled), [f"a==1 --hash=sha256:{'0' * 64} --hash=sha256:{'1' * 64}", f"b==2 --hash=sha256:{'2' * 64}"])

    def test_krea2edit_is_built_in_at_its_commit(self):
        # never ComfyUI-Manager's "nightly" (its repository's head): packs.ts holds the same commit (ownPacks.test.ts)
        text = read(BASE)
        commit = re.search(r"(?m)^ARG KREA2EDIT_COMMIT=([0-9a-f]{40})$", text).group(1)
        self.assertIn('pin comfyui-krea2edit https://github.com/lbouaraba/comfyui-krea2edit "${KREA2EDIT_COMMIT}"', text)
        with open(os.path.join(POD, "..", "..", "packages", "core", "src", "packs.ts"), encoding="utf-8") as f:
            self.assertIn(f'commit: "{commit}"', f.read())

    def test_it_holds_torch_for_every_later_pip(self):
        # Manager's installs on a pod too: a pack asking for another torch would swap the CUDA one
        self.assertRegex(read(BASE), r'(?m)^ENV PIP_CONSTRAINT=/constraints\.txt$')


class Top(unittest.TestCase):
    def test_each_cuda_build_stands_on_a_base_pinned_by_its_digest(self):
        # a moved tag cannot change a release; pod-image.yml checks the base by its label against base/Dockerfile
        text = read("Dockerfile")
        for cuda in ("cu130", "cu128"):
            self.assertRegex(text, rf"(?m)^ARG BASE_{cuda.upper()}=ghcr\.io/\S+/afflatus-pod-base:\S+@sha256:[0-9a-f]{{64}}$")
            self.assertRegex(text, rf"(?m)^FROM \$\{{BASE_{cuda.upper()}\}} AS base-{cuda}$")
        self.assertRegex(text, r"(?m)^ARG TORCH_CUDA=cu130$")
        self.assertRegex(text, r"(?m)^FROM base-\$\{TORCH_CUDA\}$")

    def test_it_installs_nothing_heavy(self):
        # torch, ComfyUI, the packs and their packages are the base's: a pod tag stays a few MB
        text = read("Dockerfile")
        for heavy in ("pip install", "apt-get", "git clone", "torch=="):
            self.assertNotIn(heavy, text)

    def test_its_registry_list_is_for_the_bases_comfyui(self):
        # made outside the base (the last stage only copies): the top says the base's ComfyUI itself
        arg = r"(?m)^ARG COMFYUI_VERSION=(v[\d.]+)$"
        self.assertEqual(re.search(arg, read("Dockerfile")).group(1), re.search(arg, read(BASE)).group(1))
        self.assertIn('"${COMFYUI_VERSION#v}"', read("Dockerfile"))

    def test_its_last_stage_only_copies_each_layer_on_its_own(self):
        # nothing run on the base and every copy --link: the build pushes the top without pulling the base's GBs
        last = read("Dockerfile").split("FROM base-${TORCH_CUDA}", 1)[1]
        steps = [line.split()[0] for line in last.splitlines() if line.strip() and not line.startswith("#")]
        self.assertEqual(set(steps), {"COPY", "EXPOSE", "CMD"})
        for line in last.splitlines():
            if line.startswith("COPY"):
                self.assertIn("--link", line)


if __name__ == "__main__":
    unittest.main()
