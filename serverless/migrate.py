"""Export private Supabase tables, stage and verify every record, then cut over."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
from urllib.parse import urlsplit
from cloud import call, invoke, cli, routing_identity
from enrich_jobs import enrich_job
from cloud_store import SupabaseStore

TABLES = ('users', 'jobs', 'deliveries', 'favorites', 'source_status')
ORDER = {'users': 'user_id.asc', 'jobs': 'id.asc', 'deliveries': 'user_id.asc,job_id.asc', 'favorites': 'user_id.asc,job_id.asc', 'source_status': 'source.asc'}


def normalized(value):
    if isinstance(value, dict):
        return {key: normalized(item) for key, item in value.items()}
    if isinstance(value, list):
        return [normalized(item) for item in value]
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return value


def canonical(row):
    return json.dumps(normalized(row), sort_keys=True, separators=(',', ':'), ensure_ascii=False)


def digest_snapshot(snapshot):
    return hashlib.sha256(canonical({table: sorted(canonical(row) for row in snapshot[table]) for table in TABLES}).encode()).hexdigest()


def export_supabase():
    store = SupabaseStore(os.environ.get('SUPABASE_URL', 'https://iajwyuldjwptkbafpmgl.supabase.co'), os.environ.get('SUPABASE_SERVICE_ROLE_KEY', ''))
    snapshot = {table: store._rows('sj_'+table, {'select': '*', 'order': ORDER[table]}) for table in TABLES}
    snapshot['jobs'] = [enrich_job(store._job(row)) for row in snapshot['jobs']]
    return snapshot


def read_cloud():
    snapshot = {}
    for table in TABLES:
        rows = []
        while True:
            page = invoke('export', table=table, offset=len(rows), limit=50)['rows']
            rows.extend(page)
            if len(page) < 50:
                break
        snapshot[table] = rows
    return snapshot


def stage(snapshot):
    before = routing_identity(call('routing'))
    invoke('reset_stage')
    for table in TABLES:
        for offset in range(0, len(snapshot[table]), 25):
            invoke('import', table=table, rows=snapshot[table][offset:offset+25])
    actual = read_cloud()
    expected_digest = digest_snapshot(snapshot)
    if digest_snapshot(actual) != expected_digest:
        raise RuntimeError('Full-record migration verification failed; original database unchanged')
    counts = {table: len(rows) for table, rows in snapshot.items()}
    invoke('verified', digest=expected_digest, counts=counts)
    if routing_identity(call('routing')) != before:
        raise RuntimeError('Webhook changed during staging; inspect before cutover')
    print('All records verified:', json.dumps(counts, sort_keys=True))
    return expected_digest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['check', 'stage', 'cutover', 'preview', 'pause', 'resume'])
    parser.add_argument('--legacy-stopped', action='store_true', help='Operator has suspended Render AND disabled the old collection workflow')
    args = parser.parse_args()
    init = invoke('init')
    if args.action == 'check':
        routing = call('routing')
        print(json.dumps({'runtime_ready': init['ready'], 'active': init['active'], 'sources': init['sources'], 'counts': init['counts'], 'webhook_host': urlsplit(routing.get('url','')).hostname, 'webhook_in_sync': routing.get('in_sync')}, ensure_ascii=False))
        return
    if args.action == 'preview':
        invoke('owner_preview'); print('Preview sent to the owner'); return
    if args.action == 'pause':
        invoke('pause'); print('Cloud processing paused'); return
    if args.action == 'resume':
        if not args.legacy_stopped:
            raise RuntimeError('Confirm the old service and collector remain stopped before resuming')
        status = invoke('status')
        if not status['ever_active'] or status.get('migration', {}).get('state') != 'verified':
            raise RuntimeError('No activated migration to resume')
        if not call('routing').get('in_sync'):
            raise RuntimeError('Webhook is not pointing to Serverless; inspect routing before resuming')
        invoke('activate', digest=status['migration']['digest'], legacyStopped=True)
        print('Cloud processing resumed; no data reimported')
        return
    if init['active'] or invoke('status')['ever_active']:
        raise RuntimeError('Bot was already activated; staging would overwrite current data and is forbidden')
    if args.action == 'cutover' and not args.legacy_stopped:
        raise RuntimeError('Suspend Render and disable its collector before the final snapshot; then use --legacy-stopped')
    remote = call('remote')
    local = {path.relative_to(Path(__file__).parent/'tgcloud').with_suffix('').as_posix(): path.read_text() for path in (Path(__file__).parent/'tgcloud').rglob('*.js')}
    if args.action == 'cutover' and remote.get('canonical_modules') and remote['canonical_modules'] != local:
        raise RuntimeError('Remote project differs from this migration; compare and back it up before deployment')
    snapshot = export_supabase()
    digest = stage(snapshot)
    if args.action == 'stage':
        print('Staged only; existing bot routing unchanged'); return
    if digest_snapshot(export_supabase()) != digest:
        raise RuntimeError('Supabase changed during migration; stop all old writers and retry')
    cli('fetch')
    latest_remote = call('remote')
    if latest_remote.get('canonical_modules') and latest_remote['canonical_modules'] != local:
        raise RuntimeError('Remote project changed during staging; stopped before deployment')
    cli('push')
    if call('remote').get('canonical_modules') != local:
        raise RuntimeError('Published modules differ from the tested version; cloud remains paused')
    synced = call('sync')
    if not synced.get('in_sync'):
        raise RuntimeError('Webhook switch not confirmed; cloud remains paused')
    invoke('activate', digest=digest, legacyStopped=True)
    invoke('owner_preview')
    print('Cutover complete; original Supabase data retained. Check /start in @SerbiaJobsBot.')


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, ValueError, OSError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
