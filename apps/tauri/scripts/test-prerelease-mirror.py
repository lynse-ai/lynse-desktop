"""Run the real mirror script with fake services to protect stable release pointers."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).with_name("mirror-release-to-cloudbase.sh")


class PrereleaseMirrorTests(unittest.TestCase):
    def test_prerelease_uploads_only_its_own_directory(self):
        with tempfile.TemporaryDirectory(prefix="lynse-mirror-test-") as directory:
            root = Path(directory)
            binaries = root / "bin"
            fixtures = root / "fixtures"
            binaries.mkdir()
            fixtures.mkdir()
            platforms = {}
            for platform, name in [("darwin-aarch64", "Lynse.app.tar.gz"), ("windows-x86_64", "Lynse_1.1.16_x64_en-US.msi")]:
                (fixtures / name).write_text("signed fixture")
                platforms[platform] = {"url": f"https://example.invalid/{name}", "signature": "fixture-signature"}
            (fixtures / "latest.json").write_text(json.dumps({"version": "1.1.16", "platforms": platforms}))
            scripts = {
                "gh": '#!/bin/bash\nwhile [[ $# -gt 0 ]]; do if [[ "$1" == --dir ]]; then cp "$FIXTURES"/* "$2"; exit 0; fi; shift; done\nexit 1\n',
                "tcb": '#!/bin/bash\nprintf "%s\\n" "$*" >> "$TCB_LOG"\n',
                "curl": '#!/bin/bash\nprintf 200\n',
            }
            for name, content in scripts.items():
                path = binaries / name
                path.write_text(content)
                path.chmod(0o755)
            env = {**os.environ, "PATH": f"{binaries}:{os.environ['PATH']}", "FIXTURES": str(fixtures),
                   "TCB_LOG": str(root / "calls"), "DIST": str(root / "dist"), "CLOUDBASE_API_KEY": "offline-fixture"}
            result = subprocess.run(["bash", str(SCRIPT), "v1.1.16-beta.1", "--prerelease"], env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            calls = (root / "calls").read_text().splitlines()
            deploys = [line for line in calls if line.startswith("hosting deploy ")]
            self.assertEqual(len(deploys), 1, calls)
            self.assertIn(" updates/v1.1.16-beta.1 ", deploys[0])
            self.assertNotIn("updates/latest", "\n".join(calls))
            self.assertIn("stable manifest and download aliases unchanged", result.stdout)

    def test_prerelease_cannot_use_the_stable_mirror_path(self):
        result = subprocess.run(["bash", str(SCRIPT), "v1.1.16-beta.1"], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("require --prerelease", result.stderr)


if __name__ == "__main__":
    unittest.main()
