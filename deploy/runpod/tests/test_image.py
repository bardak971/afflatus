"""The pod image's two Dockerfiles: the base (base/Dockerfile: torch, ComfyUI, the packs) and the top on it (Dockerfile).
The top's build context: every file it copies from the repository is let in by Dockerfile.dockerignore, which shuts out all
else. A script added to the image but not to that list fails the image's build on GitHub, after its tag is pushed
(pod-v0.1.18: died.py); here it fails before. The base copies nothing, and carries what the top's build checks it by.
"""

import json
import os
import re
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
POD = os.path.dirname(HERE)


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


class Base(unittest.TestCase):
    def test_it_copies_nothing(self):
        # its build context is its own folder, which holds the Dockerfile only
        self.assertEqual(copied(read(BASE)), [])
        self.assertEqual(sorted(os.listdir(os.path.join(POD, "base"))), ["Dockerfile"])

    def test_it_says_its_comfyui_to_the_top(self):
        # the top's registry_cache.py asks Manager's list for this ComfyUI
        text = read(BASE)
        self.assertRegex(text, r'(?m)^ARG COMFYUI_VERSION=v\d+\.\d+\.\d+$')
        self.assertRegex(text, r'(?m)^ENV AFFLATUS_COMFYUI_VERSION="\$\{COMFYUI_VERSION\}"$')

    def test_it_is_labelled_with_the_hash_its_workflow_gives(self):
        # pod-image.yml builds the top only on a base made from this commit's file
        self.assertRegex(read(BASE), r'afflatus\.base-dockerfile-sha256="\$\{BASE_DOCKERFILE_SHA256\}"')
        self.assertRegex(read(BASE), r'afflatus\.cuda="\$\{TORCH_CUDA\}"')

    def test_it_holds_torch_for_every_later_pip(self):
        # Manager's installs on a pod too: a pack asking for another torch would swap the CUDA one
        self.assertRegex(read(BASE), r'(?m)^ENV PIP_CONSTRAINT=/constraints\.txt$')


if __name__ == "__main__":
    unittest.main()
