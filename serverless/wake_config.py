"""Explicit owner setup only; never called by deployment or normal collection."""
import os
import sys
import json
from urllib.request import Request, urlopen
from cloud import invoke


def verify_wake_access(value):
    """One explicit setup probe; the queued catch-up rechecks freshness/leases."""
    request = Request('https://api.github.com/repos/AngryVirus/serbia-jobs-bot/actions/workflows/catch-up.yml/dispatches',
                      data=json.dumps({'ref': 'main'}).encode(), method='POST',
                      headers={'Authorization': 'Bearer ' + value, 'Accept': 'application/vnd.github+json',
                               'Content-Type': 'application/json', 'User-Agent': 'SerbiaJobsBot-wake-setup',
                               'X-GitHub-Api-Version': '2022-11-28'})
    try:
        with urlopen(request, timeout=20) as response:
            if response.status != 204:
                raise ValueError()
    except (OSError, ValueError):
        raise RuntimeError('GitHub did not confirm the setup probe; private details withheld') from None


def main():
    enabled = os.environ.get('SJC_WAKE_ENABLED', 'false')
    if enabled not in ('true', 'false'):
        raise RuntimeError('Invalid wake setup choice')
    fields = {'enabled': enabled == 'true'}
    if fields['enabled']:
        value = os.environ.get('SJC_GITHUB_WAKE_TOKEN', '')
        if not value:
            raise RuntimeError('Configure the dedicated GitHub Actions wake credential first')
        verify_wake_access(value)
        fields['credential'] = value
    result = invoke('collection_wake_configure', **fields)
    if result.get('enabled') is not fields['enabled']:
        raise RuntimeError('Wake configuration was not confirmed')
    print('Bot collection wake enabled' if fields['enabled'] else 'Bot collection wake disabled')


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, ValueError, OSError):
        print('Wake setup failed; private details withheld', file=sys.stderr)
        raise SystemExit(1)
