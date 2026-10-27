"""Update an activated bot's code without reimporting data or changing routing."""
import hashlib
import json
from pathlib import Path
import sys
from cloud import call, cli, invoke, routing_identity

# Reviewed predecessor: 241fb92, revision 36, verified in run 40484883299.
# A later release must explicitly review and update its predecessor digest.
PREVIOUS_DIGEST = '69213b7fe58c3f7a341436b6f343de1b6941d999aacc583d9d1aa2952ca6f2dc'  # pragma: allowlist secret


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
    rating_audit = invoke('ratings_check')
    image_audit = invoke('menu_image_audit')  # Rendering and InputFile support before changing live handlers.
    audit = invoke('audit')  # Run the new code read-only against the real catalog first.
    if remote != local:
        cli('fetch')  # revision-checked push; preserves local working files
        if call('remote').get('canonical_modules') != remote:
            raise RuntimeError('Remote code changed during review; stopped before push')
        cli('push')
    if call('remote').get('canonical_modules') != local:
        raise RuntimeError('Deployment not confirmed; inspect remote code before retrying')
    # Apply additive IF NOT EXISTS indexes immediately, without import or routing changes.
    invoke('init')
    after_routing = call('routing')
    if not after_routing.get('in_sync') or routing_identity(after_routing) != routing_identity(routing):
        raise RuntimeError('Routing changed unexpectedly; inspect webhook')
    after = invoke('status')
    if not after['active']:
        raise RuntimeError('Bot is paused; inspect status')
    print(json.dumps({'deployed': True, 'modules': len(local), 'digest': digest(local), 'active': after['active'],
                      'routing_unchanged': True, 'counts': after['counts'], 'catalog': audit, 'image_rendering': image_audit, 'ratings': rating_audit}, ensure_ascii=False))


if __name__ == '__main__':
    try:
        deploy()
    except (RuntimeError, ValueError, OSError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
