"""registry_cache.py, Manager's list of node packs kept in the image: a published image's build fails without it.

Standard library only, as the script is: `python -m unittest discover deploy/runpod/tests` runs them, and so does pytest.
"""

import importlib.util
import io
import json
import os
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("registry_cache", os.path.join(os.path.dirname(HERE), "registry_cache.py"))
registry_cache = importlib.util.module_from_spec(spec)
spec.loader.exec_module(registry_cache)


class Page(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def registry(*pages):
    def opener(req, timeout):
        page = int(req.full_url.split("page=")[1].split("&")[0])
        return Page(json.dumps({"nodes": pages[page - 1], "totalPages": len(pages)}).encode())

    return opener


def unreachable(req, timeout):
    raise OSError("api.comfy.org unreachable")


class Main(unittest.TestCase):
    def test_writes_the_list_as_manager_keeps_it(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(registry_cache.main(d, "0.37.0", required=True, opener=registry([{"id": "a"}], [{"id": "b", "latest_version": {"version": "1.0"}}])), 0)
            with open(os.path.join(d, registry_cache.cache_name()), encoding="utf-8") as f:
                nodes = json.load(f)["nodes"]
            self.assertEqual([(n["id"], n["latest_version"]["version"]) for n in nodes], [("a", "nightly"), ("b", "1.0")])

    def test_a_local_build_goes_on_without_the_registry(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(registry_cache.main(d, "0.37.0", opener=unreachable), 0)
            self.assertEqual(os.listdir(d), [])

    def test_a_published_build_fails_without_the_registry(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(registry_cache.main(d, "0.37.0", required=True, opener=unreachable), 1)
            # a registry that answers with no pack at all is no list either
            self.assertEqual(registry_cache.main(d, "0.37.0", required=True, opener=registry([])), 1)
            self.assertEqual(os.listdir(d), [])


if __name__ == "__main__":
    unittest.main()
