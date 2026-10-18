"""All configured Serbian job sources -> cloud database -> immediate matching alerts."""
import json
import sys
import time
import uuid
from cloud import invoke
from enrich_jobs import enrich_job
from sources import collect_all


def notify(deadline):
    sent, uncertain = 0, 0
    while time.monotonic() < deadline:
        # The database owns the cursor, so another cycle resumes after the last
        # processed subscriber rather than starting again at the smallest ID.
        result = invoke('notify_batch', limit=10)
        sent += result.get('sent', 0)
        uncertain += result.get('uncertain', 0)
        if result.get('retry_after') or result.get('busy') or result.get('done'):
            # An explicit 429 retains the retryable delivery in cloud. Never
            # wait out a cooldown inside this collection's limited budget.
            break
        # At most ten sends per batch; pacing stays outside the cloud isolate.
        remaining = deadline - time.monotonic()
        if remaining > 0:
            time.sleep(min(1.1, remaining))
    return sent, uncertain


def main():
    status = invoke('init')
    if not status['active']:
        print('Cloud collection skipped: migration has not been activated')
        return
    owner = str(uuid.uuid4())
    invoke('collection_begin', owner=owner)
    failed = True
    totals = {'added': 0, 'sent': 0, 'uncertain': 0, 'sources': 0, 'healthy_sources': 0}
    deadline = time.monotonic() + 1200
    try:
        sent, uncertain = notify(min(deadline, time.monotonic()+30))
        totals['sent'] += sent; totals['uncertain'] += uncertain
        def on_source(source, jobs, status):
            if time.monotonic() > deadline:
                raise RuntimeError('Collection budget reached; saved results retained for next cycle')
            enriched = [enrich_job(job) for job in jobs]
            batches = [enriched[i:i+25] for i in range(0,len(enriched),25)] or [[]]
            added = 0
            for batch in batches:
                added += invoke('collect', source=source, jobs=batch, status=status, owner=owner)['added']
            totals['added'] += added; totals['sources'] += 1
            if status.get('state') in ('ok', 'empty'):
                totals['healthy_sources'] += 1
            print('Source', source, status.get('state'), 'found', len(jobs), 'new', added, flush=True)
            if added:
                sent, uncertain = notify(min(deadline,time.monotonic()+30))
                totals['sent'] += sent; totals['uncertain'] += uncertain
        # Expiry corrections reach cloud too. Cloud only updates already-known
        # expired URLs, so this cannot import an archive of old vacancies.
        collect_all(on_source=on_source, include_expired=True)
        sent, uncertain = notify(deadline)
        totals['sent'] += sent; totals['uncertain'] += uncertain
        failed = False
        print('Collection complete:', json.dumps(totals))
    finally:
        invoke('collection_end',owner=owner,failed=failed,totals=totals)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, RuntimeError, OSError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
