"""Owner-only cloud smoke test: CLI run only; no deploy, migrate or webhook sync."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent
CLI = ROOT / 'node_modules' / '@tgcloud' / 'cli' / 'bin' / 'tgcloud.js'


def read_config(environ):
    token = environ.get('TGCLOUD_TOKEN', '')
    if not re.fullmatch(r'app\d+:[A-Za-z0-9_-]+', token):
        raise ValueError('Add the Serverless CLI token as GitHub Actions secret TGCLOUD_PROBE_TOKEN')
    value = environ.get('PROBE_CHAT_ID', '')
    if not re.fullmatch(r'[1-9]\d{0,15}', value) or int(value) > 2**53 - 1:
        raise ValueError('PROBE_CHAT_ID must be your positive numeric private chat ID')
    return {'chatId': int(value), 'botUsername': 'SerbiaJobsBot', 'recipientUsername': 'AngryVirus'}


def parse_result(output):
    for line in output.splitlines():
        match = re.match(r'^\s*SJ_PROBE_RESULT:(\{.*)', line)
        if match:
            return json.JSONDecoder().raw_decode(match[1])[0]
    raise RuntimeError('CLI did not return a structured probe result')


def invoke(operation, config, jobs):
    env = dict(os.environ, NO_COLOR='1')
    # Debug prints the full management request; the probe never enables it.
    for key in ('TGCLOUD_DEBUG', 'FORCE_COLOR', 'TG_CLOUD_API_URL', 'TGCLOUD_BETA'):
        env.pop(key, None)
    command = ['node', str(CLI), 'run', 'endpoints/probe',
               json.dumps(dict(config, jobs=jobs, operation=operation), ensure_ascii=False),
               '--ctx', '{"probeRun":true}']
    try:
        completed = subprocess.run(command, cwd=ROOT, env=env, text=True,
                                   capture_output=True, timeout=120)
    except subprocess.TimeoutExpired:
        raise RuntimeError(f'{operation}: cloud call timed out; delivery may have occurred, inspect status before retrying') from None
    if completed.returncode:
        # Do not echo CLI arguments, credentials, or the complete API response.
        errors = [line for line in (completed.stdout + completed.stderr).splitlines()
                  if 'Error:' in line or '✗' in line or 'no changes made' in line]
        detail = errors[-1] if errors else 'CLI request failed; check Serverless access and network'
        detail = detail.replace(env['TGCLOUD_TOKEN'], '[redacted]')
        detail = re.sub(r'app\d+:[A-Za-z0-9_-]+', '[redacted]', detail)
        detail = re.sub(r'[\x00-\x1f\x7f]', '', detail)[:400]
        raise RuntimeError(f'{operation}: {detail}')
    return parse_result(completed.stdout)


def assert_persisted(result, expected):
    rows = result.get('rows', [])
    if len(rows) != expected or not all(row['stored'] and row['matches'] and row['state'] == 'sent' for row in rows):
        raise RuntimeError('Persistence or delivery check failed; inspect the private chat and probe status')


def read_routing():
    token = os.environ['TGCLOUD_TOKEN']
    app = token.split(':', 1)[0]
    request = Request(f'https://cloud.telegram.org/{app}/manage/webhook',
                      headers={'Authorization': 'Bearer ' + token})
    with urlopen(request, timeout=30) as response:
        data = json.load(response)
    if data.get('ok') is not True:
        raise RuntimeError('Could not read existing webhook; stopped before writing data or sending messages')
    result = data['result']
    return {key: result.get(key) for key in ('url', 'allowed_updates')}


def exercise(config, jobs, call=invoke, pause=time.sleep):
    report = {'prepare': call('prepare', config, jobs)}
    report['imports'] = []
    for job in jobs:
        result = call('import', config, [job])
        assert_persisted(result, 1)
        report['imports'].append(result)
        pause(1.1)  # Telegram per-chat pacing happens outside the V8 invocation.
    # A separate platform invocation must observe the saved data.
    report['verify'] = call('verify', config, jobs)
    assert_persisted(report['verify'], len(jobs))
    report['repeats'] = []
    for job in jobs:
        result = call('import', config, [job])
        assert_persisted(result, 1)
        if result.get('sent') != 0:
            raise RuntimeError('Duplicate notification check failed')
        report['repeats'].append(result)
    report['ok'] = True
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check-config', action='store_true')
    parser.add_argument('--status-only', action='store_true')
    parser.add_argument('--payload', type=Path, default=ROOT / 'payload.json')
    args = parser.parse_args()
    config = read_config(os.environ)
    if args.check_config:
        print('Credential format and private chat ID configured; remote access not yet tested')
        return
    if not CLI.is_file():
        raise RuntimeError('Run npm ci --ignore-scripts in serverless-probe first')
    payload = json.loads(args.payload.read_text(encoding='utf-8'))
    jobs = payload.get('jobs')
    if not isinstance(jobs, list) or not 1 <= len(jobs) <= 3:
        raise ValueError('Payload must contain 1–3 vacancies')
    before = read_routing()
    try:
        report = invoke('verify', config, jobs) if args.status_only else exercise(config, jobs)
    finally:
        if read_routing() != before:
            raise RuntimeError('Webhook changed during the probe; inspect the bot configuration before continuing')
    report['webhook_unchanged'] = True
    # The report deliberately contains counts/checks, not tokens or chat IDs.
    (ROOT / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    if args.status_only:
        print(json.dumps(report, ensure_ascii=False))
    else:
        sent = sum(result['sent'] for result in report['imports'])
        print(f'Cloud probe passed: {len(jobs)} stored, {sent} sent, 0 repeated; webhook unchanged')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, RuntimeError, OSError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
