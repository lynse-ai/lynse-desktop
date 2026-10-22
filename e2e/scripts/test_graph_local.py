"""Run HTTP -> Rust validation/storage -> desktop-renderer smoke with synthetic evidence."""
from __future__ import annotations
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import urllib.error
import urllib.request


def main():
    root = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser()
    parser.add_argument('--lynclaw-root', type=Path, default=os.environ.get('LYNCLAW_ROOT', str(root.parents[1] / 'lynclaw')))
    args = parser.parse_args()
    lynclaw = Path(args.lynclaw_root).resolve()
    python = lynclaw / '.venv/bin/python'
    if not python.exists() or not (lynclaw / 'runtime/desktop_graph.py').exists():
        parser.error('Provide a Lynclaw checkout with graph_extract and its .venv using --lynclaw-root')
    loopback = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with tempfile.TemporaryDirectory(prefix='lynse-graph-local-') as temporary:
        staging = Path(temporary)
        ready, result = staging / 'ready.json', staging / 'result.json'
        with (staging / 'service.log').open('w') as log:
            service = subprocess.Popen([str(python), str(root / 'e2e/fixtures/graph-local-service.py'), '--lynclaw-root', str(lynclaw), '--ready-file', str(ready)], cwd=root, stdout=log, stderr=subprocess.STDOUT)
            try:
                deadline = time.monotonic() + 30
                url = ''
                while time.monotonic() < deadline:
                    if service.poll() is not None:
                        raise RuntimeError((staging / 'service.log').read_text())
                    if ready.exists():
                        url = json.loads(ready.read_text())['url']
                        try:
                            with loopback.open(url + '/health', timeout=1) as response:
                                if response.status == 200:
                                    break
                        except (OSError, urllib.error.URLError):
                            pass
                    time.sleep(.1)
                else:
                    raise RuntimeError('Local synthetic Lynclaw route did not become ready: ' + (staging / 'service.log').read_text())
                print('Local Lynclaw route:', url, '(synthetic identity and model; loopback only)', flush=True)
                env = {**os.environ, 'LYNSE_GRAPH_LOCAL_URL':url, 'LYNSE_GRAPH_LOCAL_RESULT':str(result), 'LYNSE_E2E_VIDEO':'off'}
                subprocess.run(['cargo','test','--manifest-path','apps/tauri/src-tauri/Cargo.toml','local_graph_service_smoke','--lib','--','--ignored','--nocapture'], cwd=root, env=env, check=True)
                subprocess.run(['pnpm','--dir','e2e','test:desktop','06-graph-local-service.spec.ts','--workers=1'], cwd=root, env=env, check=True)
                output = root / 'e2e/test-results/graph-local-service'
                output.mkdir(parents=True, exist_ok=True)
                shutil.copy2(result, output / 'result.json')
                with loopback.open(url + '/health', timeout=2) as response:
                    health = json.load(response)
                (output / 'health.json').write_text(json.dumps(health, indent=2), encoding='utf-8')
                print('Local HTTP, Rust graph and desktop-renderer smoke passed. Results:', output, flush=True)
            finally:
                service.terminate()
                try:
                    service.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    service.kill()
                    service.wait()


if __name__ == '__main__':
    main()
