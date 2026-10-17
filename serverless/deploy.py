"""Update an activated bot's code without reimporting data or changing routing."""
import hashlib
import json
from pathlib import Path
import sys
from cloud import call, cli, invoke, routing_identity

# Reviewed predecessor: 0a29627 (source policy and compact owner dashboard).
# A later release must explicitly review and update its predecessor digest.
PREVIOUS_DIGEST = '96aa2732e509d2e281a0d7b9da48f8bb084ad6c8a981237b0bd659ffb599e3cb'


def digest(modules):
    return hashlib.sha256(json.dumps(modules, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()


def deploy():
    root = Path(__file__).parent / 'tgcloud'
    local = {p.relative_to(root).with_suffix('').as_posix(): p.read_text() for p in root.rglob('*.js')}
    before = invoke('status')
    routing = call('routing')
    if not before['active'] or not before['ever_active'] or not routing.get('in_sync'):
        raise RuntimeError('Expected an active migrated bot with synchronized routing')
    remote = call('remote').get('canonical_modules', {})
    if remote != local and digest(remote) != PREVIOUS_DIGEST:
        raise RuntimeError('Unexpected deployed code; review changes before updating')
    if {k for k in remote if k.startswith('handlers/')} != {k for k in local if k.startswith('handlers/')} or 'schema' in local:
        raise RuntimeError('This updater cannot change handlers or database schema')
    audit = invoke('audit')  # Run the new code read-only against the real catalog first.
    if remote != local:
        cli('fetch')  # revision-checked push; preserves local working files
        if call('remote').get('canonical_modules') != remote:
            raise RuntimeError('Remote code changed during review; stopped before push')
        cli('push')
    if call('remote').get('canonical_modules') != local:
        raise RuntimeError('Deployment not confirmed; inspect remote code before retrying')
    after_routing = call('routing')
    if not after_routing.get('in_sync') or routing_identity(after_routing) != routing_identity(routing):
        raise RuntimeError('Routing changed unexpectedly; inspect webhook')
    after = invoke('status')
    if not after['active']:
        raise RuntimeError('Bot is paused; inspect status')
    print(json.dumps({'deployed': True, 'modules': len(local), 'digest': digest(local), 'active': after['active'],
                      'routing_unchanged': True, 'counts': after['counts'], 'catalog': audit}, ensure_ascii=False))


if __name__ == '__main__':
    try:
        deploy()
    except (RuntimeError, ValueError, OSError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
