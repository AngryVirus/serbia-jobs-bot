"""All configured Serbian job sources -> cloud database -> immediate matching alerts."""
import json
import sys
import time
import uuid
from cloud import invoke
from enrich_jobs import enrich_job
from sources import collect_all


def subscribers():
    result, offset = [], 0
    while True:
        page = invoke('subscribers', offset=offset)
        result.extend(page['ids'])
        if page['next'] is None:
            return result
        offset = page['next']


def notify(deadline):
    pending = subscribers()
    sent, uncertain = 0, 0
    while pending and time.monotonic() < deadline:
        more = []
        for uid in pending:
            if time.monotonic() >= deadline:
                break
            result = invoke('notify', user_id=uid)
            sent += result.get('sent', 0)
            uncertain += bool(result.get('uncertain'))
            if result.get('retry_after'):
                # Persisted claim was released only for an explicit 429 response.
                # Finish this cycle; the next scheduled cycle retries the backlog.
                return sent, uncertain
            if not result.get('done'):
                more.append(uid)
            time.sleep(1.1)  # Pacing belongs in the worker, not the cloud isolate.
        pending = more
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
        collect_all(on_source=on_source)  # Reviewed active sources; no per-user source filter.
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
