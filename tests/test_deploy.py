"""Guard the static deployment's routing against the PWA's own asset graph.

The deployed copy serves the mobile app from the site root, but the app
references its assets relatively ("./app.js"). That means every asset the app
needs is requested at the root of the domain. A rewrite that serves the HTML at
"/" without also mapping those assets produces a page that loads with no CSS and
no JavaScript - which is exactly the failure this test exists to prevent: the
shell arrives, the profile list, extraction contract and styling do not, and the
symptom looks like a code bug rather than a routing one.
"""

from __future__ import annotations

import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STATIC = ROOT / "fieldlens" / "static"
VERCEL = ROOT / "vercel.json"

# Matches "./name.ext", "../name.ext" and bare "name.ext" in href/src/import
# forms. Only same-directory references matter here: the app is a flat folder.
REF_RE = re.compile(r"""(?:href|src)=["']\.?/?([A-Za-z0-9_.-]+\.(?:js|css|svg|webmanifest))["']""")
IMPORT_RE = re.compile(r"""from\s+["']\./?([A-Za-z0-9_.-]+\.js)["']""")
PRECACHE_RE = re.compile(r"""["']\./?([A-Za-z0-9_.-]+\.(?:js|css|svg|webmanifest|html))["']""")


class DeploymentRoutingTest(unittest.TestCase):
    def setUp(self) -> None:
        self.config = json.loads(VERCEL.read_text())
        self.routes = self.config["routes"]

    def mapped_destinations(self) -> dict[str, str]:
        out: dict[str, str] = {}
        for route in self.routes:
            src = route.get("src")
            dest = route.get("dest")
            if src and dest and not any(ch in src for ch in "()\\*+?"):
                out[src.lstrip("/")] = dest
        return out

    def referenced_assets(self) -> set[str]:
        found: set[str] = set()
        for name in ("index.html", "app.js", "sw.js"):
            text = (STATIC / name).read_text()
            pattern = PRECACHE_RE if name == "sw.js" else None
            for regex in (REF_RE, IMPORT_RE, pattern):
                if regex is None:
                    continue
                found.update(regex.findall(text))
        return found

    def test_every_asset_the_app_requests_is_reachable_from_the_site_root(self):
        mapped = self.mapped_destinations()
        missing = []
        for asset in sorted(self.referenced_assets()):
            dest = mapped.get(asset)
            if dest is None:
                missing.append(f"{asset}: no root mapping")
                continue
            if not (ROOT / dest.lstrip("/")).is_file():
                missing.append(f"{asset}: maps to {dest} which does not exist")
        self.assertEqual(missing, [], "assets unreachable at site root: " + "; ".join(missing))

    def test_a_mapping_is_not_pointed_at_a_missing_file(self):
        broken = [
            f"{src} -> {dest}"
            for src, dest in self.mapped_destinations().items()
            if not (ROOT / dest.lstrip("/")).is_file()
        ]
        self.assertEqual(broken, [])

    def test_server_sources_and_tests_are_not_served_by_the_deployment(self):
        # The deployed copy is public; the Python server and the test suite must
        # not be downloadable from it.
        statuses = {r.get("src"): r.get("status") for r in self.routes}
        for pattern in (r"/(.*)\.py$", "/tests/(.*)"):
            self.assertEqual(statuses.get(pattern), 404, f"{pattern} must 404 on the deployment")

    def test_filesystem_fallback_is_last_so_it_cannot_shadow_the_mappings(self):
        self.assertEqual(
            self.routes[-1], {"handle": "filesystem"},
            "the filesystem fallback must come last, or it would serve assets before the mappings apply",
        )


if __name__ == "__main__":
    unittest.main()
