"""Explicit owner setup only; never called by deployment or normal collection."""
import os
import sys
from cloud import invoke


def main():
    enabled = os.environ.get('SJC_WAKE_ENABLED', 'false')
    if enabled not in ('true', 'false'):
        raise RuntimeError('Invalid wake setup choice')
    fields = {'enabled': enabled == 'true'}
    if fields['enabled']:
        value = os.environ.get('SJC_GITHUB_WAKE_TOKEN', '')
        if not value:
            raise RuntimeError('Configure the dedicated GitHub Actions wake credential first')
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
