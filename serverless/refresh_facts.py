"""Versioned, resumable refresh of public derived facts; existing source rows use CAS."""
import hashlib
import json
from pathlib import Path
import sys
import time
import uuid
from cloud import invoke
from enrich_jobs import enrich_job


def facts_version():
    root = Path(__file__).resolve().parents[1]
    files = ['serverless/enrich_jobs.py', 'job_metadata.py', 'job_quality.py',
             'residence_permit.py', 'filters.py', 'addresses.py', 'location_links.py',
             'salary_facts.py', 'filter_vocabulary.py', 'serbian_geography.py',
             'telegram_sources.py']
    digest = hashlib.sha256()
    for name in files:
        digest.update(name.encode())
        digest.update((root / name).read_bytes())
    return digest.hexdigest()


def refresh(force=False, budget=None):
    """Refresh derived facts; with a budget, stop between pages and resume later.

    A full pass over a large catalogue takes longer than one Actions job and
    makes the management gateway throttle whatever runs next. The cloud keeps
    the cursor, so a paused pass continues from the same row in a later run.
    """
    version = facts_version()
    started = time.monotonic()
    status = invoke('facts_status')
    if not force and status.get('version') == version:
        print('Public job facts already current; no catalog scan required')
        return
    owner = str(uuid.uuid4())
    progress = invoke('facts_begin', version=version, owner=owner, force=force)
    updated, skipped, unchanged = 0, 0, 0
    paused = False
    try:
        while True:
            if budget is not None and time.monotonic() - started >= budget:
                paused = True
                break
            page = invoke('facts_page', version=version, owner=owner)
            rows = page['rows']
            if not rows:
                break
            enriched = []
            for row in rows:
                fresh = enrich_job(row)
                if row.get('_cloud') == fresh['_cloud']:
                    unchanged += 1
                else:
                    enriched.append(fresh)
            result = invoke('facts_apply', version=version, owner=owner,
                            after=rows[-1]['id'], rows=enriched)
            updated += result['updated']; skipped += result['skipped']
            print('Public job facts progress:', json.dumps({'after_id': rows[-1]['id'],
                  'updated': updated, 'unchanged': unchanged,
                  'concurrent_changes_skipped': skipped}), flush=True)
        if not paused:
            invoke('facts_finish', version=version, owner=owner)
    finally:
        # Releasing a completed lease is idempotent. Never mask the original result.
        try:
            invoke('facts_release', version=version, owner=owner)
        except (RuntimeError, OSError):
            print('Facts lease cleanup deferred to expiry')
    if paused:
        print('Public job facts refresh paused at its time budget; a later run resumes from the saved row:',
              json.dumps({'updated': updated, 'unchanged': unchanged, 'concurrent_changes_skipped': skipped,
                          'resumed_after_id': progress['after']}))
        return
    print('Public job facts refreshed:', json.dumps({'updated': updated, 'unchanged': unchanged,
          'concurrent_changes_skipped': skipped, 'resumed_after_id': progress['after']}))


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--budget', type=float, default=None, help='seconds; pause between pages after this long')
    try:
        refresh(budget=parser.parse_args().budget)
    except (ValueError, RuntimeError, OSError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
