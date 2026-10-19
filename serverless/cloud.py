"""Private process bridge. Never prints exported records or management URLs."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import math
from urllib.request import Request, urlopen
ROOT = Path(__file__).resolve().parent
HEAVY_WORKFLOWS = {'.github/workflows/serverless.yml', '.github/workflows/backup.yml',
                   '.github/workflows/catch-up.yml'}


class CloudRequestError(RuntimeError):
    def __init__(self, message, *, transient=False):
        super().__init__(message)
        self.transient = transient


def running_workflows(env):
    """Read GitHub metadata only; never spend Cloud quota while waiting."""
    repository = env.get('GITHUB_REPOSITORY', '')
    if repository != 'AngryVirus/serbia-jobs-bot' or not env.get('GITHUB_TOKEN'):
        raise RuntimeError('Management coordination requires the built-in Actions read token')
    request = Request(f'https://api.github.com/repos/{repository}/actions/runs?status=in_progress&per_page=100',
                      headers={'Authorization': 'Bearer '+env['GITHUB_TOKEN'], 'Accept': 'application/vnd.github+json',
                               'X-GitHub-Api-Version': '2022-11-28'})
    try:
        with urlopen(request, timeout=20) as response:
            data = json.load(response)
        if data.get('total_count', 101) > 100 or not isinstance(data.get('workflow_runs'), list):
            raise ValueError()
        return data['workflow_runs']
    except (OSError, ValueError):
        raise RuntimeError('Cannot read management queue; stopped before contacting Cloud') from None


def management_turn(env):
    if env.get('CLOUD_MANAGEMENT_GATE') != '1' or env.get('CLOUD_MANAGEMENT_PRIORITY') == 'watchdog':
        return
    own = int(env.get('GITHUB_RUN_ID', '0'))
    if own <= 0:
        raise RuntimeError('Management coordination requires an Actions run ID')
    deadline = time.monotonic()+600
    announced = False
    while True:
        runs = running_workflows(env)
        waiting = any(r.get('id') != own and (
            r.get('path') == '.github/workflows/health.yml' or
            (r.get('path') in HEAVY_WORKFLOWS and isinstance(r.get('id'), int) and r['id'] < own)) for r in runs)
        if not waiting:
            return
        if time.monotonic() >= deadline:
            raise CloudRequestError('Management queue wait exceeded ten minutes; retry in a later cycle', transient=True)
        if not announced:
            print('Waiting for earlier maintenance or independent watchdog; no Cloud requests sent', file=sys.stderr, flush=True)
            announced = True
        time.sleep(15)


def pace_path(env):
    return env.get('CLOUD_PACE_FILE') or (str(Path(env['RUNNER_TEMP'])/'serbia-jobs-cloud-clock') if env.get('RUNNER_TEMP') else None)


def pace(env):
    management_turn(env)
    value, path = env.get('CLOUD_REQUEST_INTERVAL', '0'), pace_path(env)
    try:
        interval = float(value)
        if not math.isfinite(interval) or interval < 0 or interval > 60:
            raise ValueError()
    except ValueError:
        raise RuntimeError('Invalid management pacing configuration') from None
    if not interval or not path:
        return
    # Same-run Python processes share a clock file; separate runs use the read-only queue above.
    import fcntl
    with open(path, 'a+') as clock:
        fcntl.flock(clock, fcntl.LOCK_EX)
        clock.seek(0)
        try:
            saved=json.loads(clock.read() or '0')
            previous=float(saved.get('at',0) if isinstance(saved,dict) else saved)
            interval=max(interval,min(60,float(saved.get('interval',0)))) if isinstance(saved,dict) else interval
            if not math.isfinite(previous) or not math.isfinite(interval):raise ValueError()
        except (ValueError,TypeError):
            previous=0;interval=float(value)
        delay = previous+interval-time.monotonic()
        if delay > 0:
            time.sleep(min(interval, delay))
        clock.seek(0);clock.truncate();json.dump({'at':time.monotonic(),'interval':interval},clock);clock.flush()


def adapt_pacing(env,delay):
    """An explicit 429 teaches later Python processes in this run a safer interval."""
    path=pace_path(env)
    if not path or not float(env.get('CLOUD_REQUEST_INTERVAL','0')):
        return
    import fcntl
    with open(path,'a+') as clock:
        fcntl.flock(clock,fcntl.LOCK_EX);clock.seek(0)
        try:
            saved=json.loads(clock.read() or '{}')
            if not isinstance(saved,dict):saved={'at':float(saved)}
        except (ValueError,TypeError):saved={}
        saved['interval']=min(60,max(float(saved.get('interval',0)),math.ceil(delay)+1))
        saved.setdefault('at',time.monotonic())
        clock.seek(0);clock.truncate();json.dump(saved,clock);clock.flush()


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
        pace(env)
        try:
            completed = subprocess.run(['node', str(ROOT/'bridge.mjs')], input=payload,
                                       cwd=ROOT, env=env, text=True, capture_output=True, timeout=150)
        except subprocess.TimeoutExpired:
            raise CloudRequestError('Cloud request timed out; check state before retrying mutations', transient=True) from None
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
                    raise CloudRequestError('Cloud rate limit exceeds the retry budget; retry in the next collection cycle', transient=True)
                delay = max(1, math.ceil(delay))
                adapt_pacing(env,delay)
                print(f'Telegram Cloud rate limit; waiting {delay}s before retry {attempt+1}/3', file=sys.stderr, flush=True)
                time.sleep(delay)
                continue
            status=output.get('status')
            raise CloudRequestError(f'Cloud {command} failed (status {status}, code {output.get("code")}); private details withheld',
                                    transient=status==429 or isinstance(status,int) and status>=500)
        result = output.get('result')
        if not isinstance(result, dict):
            raise RuntimeError('Invalid cloud response')
        return result


def invoke(operation, **fields):
    return call('run', args=dict(operation=operation, **fields))


def routing_identity(result):
    return {key: result.get(key) for key in ('url', 'allowed_updates')}


def cli(*arguments):
    env=environment();pace(env)
    result = subprocess.run(['node', str(ROOT/'node_modules/@tgcloud/cli/bin/tgcloud.js'), *arguments], cwd=ROOT,
                            env=env, text=True, capture_output=True, timeout=180)
    if result.returncode:
        raise RuntimeError('Official CLI command failed: ' + arguments[0] + '; private output withheld')
