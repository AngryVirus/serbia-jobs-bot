"""Private process bridge. Never prints exported records or management URLs."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import math
ROOT = Path(__file__).resolve().parent


def environment():
    env = dict(os.environ, NO_COLOR='1')
    for key in ('TGCLOUD_DEBUG', 'TG_CLOUD_API_URL', 'TGCLOUD_BETA', 'FORCE_COLOR'):
        env.pop(key, None)
    if not re.fullmatch(r'app8802394224:[A-Za-z0-9_-]+', env.get('TGCLOUD_TOKEN', '')):
        raise RuntimeError('Configure GitHub secret TGCLOUD_PROBE_TOKEN for the main bot')
    return env


def call(command, **fields):
    payload = json.dumps(dict(command=command, **fields), ensure_ascii=False)
    env = environment()
    for attempt in range(4):
        try:
            completed = subprocess.run(['node', str(ROOT/'bridge.mjs')], input=payload,
                                       cwd=ROOT, env=env, text=True, capture_output=True, timeout=150)
        except subprocess.TimeoutExpired:
            raise RuntimeError('Cloud request timed out; check state before retrying mutations') from None
        try:
            output = json.loads(completed.stdout)
        except ValueError:
            raise RuntimeError('Cloud bridge failed; no private output was logged') from None
        if completed.returncode or not output.get('ok'):
            # Retry only an explicit HTTP 429 from the management gateway.
            # Timeouts/5xx and errors inside a running function can follow writes.
            if output.get('status') == 429 and attempt < 3:
                delay = output.get('retry_after')
                if not isinstance(delay, (int, float)) or isinstance(delay, bool) or not math.isfinite(delay) or delay <= 0:
                    delay = 60 * (attempt + 1)
                if delay > 300:
                    raise RuntimeError('Cloud rate limit exceeds the retry budget; retry in the next collection cycle')
                delay = max(1, math.ceil(delay))
                print(f'Telegram Cloud rate limit; waiting {delay}s before retry {attempt+1}/3', file=sys.stderr, flush=True)
                time.sleep(delay)
                continue
            raise RuntimeError(f'Cloud {command} failed (status {output.get("status")}, code {output.get("code")}); private details withheld')
        result = output.get('result')
        if not isinstance(result, dict):
            raise RuntimeError('Invalid cloud response')
        return result


def invoke(operation, **fields):
    return call('run', args=dict(operation=operation, **fields))


def routing_identity(result):
    return {key: result.get(key) for key in ('url', 'allowed_updates')}


def cli(*arguments):
    result = subprocess.run(['node', str(ROOT/'node_modules/@tgcloud/cli/bin/tgcloud.js'), *arguments], cwd=ROOT,
                            env=environment(), text=True, capture_output=True, timeout=180)
    if result.returncode:
        raise RuntimeError('Official CLI command failed: ' + arguments[0] + '; private output withheld')
