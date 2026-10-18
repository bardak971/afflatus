"""The pod image's Dockerfile against its build context: every file it copies from the repository is let in by
Dockerfile.dockerignore, which shuts out all else. A script added to the image but not to that list fails the image's build
on GitHub, after its tag is pushed (pod-v0.1.18: died.py); here it fails before.
"""

import os
import re
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
POD = os.path.dirname(HERE)


def read(name):
    with open(os.path.join(POD, name), encoding="utf-8") as f:
        return f.read()


def copied():
    """The repository paths the Dockerfile's COPY lines take (not those from another stage, --from=)."""
    out = []
    for line in read("Dockerfile").splitlines():
        found = re.match(r"^COPY\s+(?!--from)(?:--\S+\s+)*(\S+)\s+\S+\s*$", line.strip())
        if found:
            out.append(found.group(1))
    return out


def let_in():
    """What the ignore file lets in after its "*": its "!" lines."""
    return [line[1:].strip() for line in read("Dockerfile.dockerignore").splitlines() if line.startswith("!")]


class RtxVsr(unittest.TestCase):
    def test_the_rtx_route_has_nvidias_runtime_pinned_by_its_hash(self):
        # DaSiWa's RTX node imports nvvfx when it runs: the image without it failed every RTX VSR finish on a pod
        found = re.search(r'pip install --no-deps "nvidia-vfx @ (https://pypi\.nvidia\.com/\S+\.whl)#sha256=([0-9a-f]{64})"', read("Dockerfile"))
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


if __name__ == "__main__":
    unittest.main()
