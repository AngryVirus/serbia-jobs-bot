"""All configured Serbian job sources -> cloud database -> immediate matching alerts."""
import json
import sys
import time
import uuid
from cloud import invoke
from enrich_jobs import enrich_job
from sources import SOURCES, collect_all
from source_policy import source_enabled


MAX_BATCH_BYTES = 90 * 1024


def upload_batches(jobs):
    """Keep full public descriptions without exceeding a bounded RPC payload."""
    batch, size = [], 2
    for job in jobs:
        encoded = len(json.dumps(job, ensure_ascii=False, separators=(',', ':')).encode('utf-8')) + 1
        if encoded + 2 > MAX_BATCH_BYTES:
            raise RuntimeError('Vacancy exceeds the safe collection batch size')
        if batch and (len(batch) >= 25 or size + encoded > MAX_BATCH_BYTES):
            yield batch
            batch, size = [], 2
        batch.append(job)
        size += encoded
    if batch:
        yield batch


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
    totals = {'added': 0, 'sent': 0, 'uncertain': 0, 'sources': 0, 'healthy_sources': 0,
              'discovered': 0, 'inspected': 0, 'parsed_count': 0,
              'skipped_known': 0, 'rejected': 0, 'truncated_sources': 0}
    deadline = time.monotonic() + 1200
    try:
        # State belongs to the shared database, not an ephemeral Actions checkout.
        # Read one bounded source at a time; never export users or credentials.
        crawl_states = {}
        for source in SOURCES:
            if source_enabled(source):
                if time.monotonic() >= deadline:
                    raise RuntimeError('Collection budget reached while loading source positions')
                crawl_states[source] = invoke('collection_state', owner=owner, source=source).get('state', {})
        sent, uncertain = notify(min(deadline, time.monotonic()+30))
        totals['sent'] += sent; totals['uncertain'] += uncertain
        def on_source(source, jobs, status):
            if time.monotonic() > deadline:
                raise RuntimeError('Collection budget reached; saved results retained for next cycle')
            enriched = [enrich_job(job) for job in jobs]
            batches = list(upload_batches(enriched))
            added = 0
            for batch in batches:
                if time.monotonic() >= deadline:
                    raise RuntimeError('Collection budget reached; source position retained for retry')
                written = invoke('collect', source=source, jobs=batch, owner=owner)['added']
                added += written
                totals['added'] += written
            # A separate final commit keeps a large checkpoint from sharing the
            # RPC's byte budget with long descriptions. Earlier upload failure
            # leaves the old source position intact for a safe retry.
            if time.monotonic() >= deadline:
                raise RuntimeError('Collection budget reached; source position retained for retry')
            invoke('collect', source=source, jobs=[], status=status, owner=owner)
            totals['sources'] += 1
            if (status.get('state') in ('ok', 'empty') and status.get('healthy') is not False
                    or status.get('state') == 'partial' and status.get('healthy') is True):
                totals['healthy_sources'] += 1
            metrics = {key: status.get(key, 0) for key in ('discovered', 'inspected', 'parsed_count', 'skipped_known')}
            for key, value in metrics.items():
                if type(value) is int and value >= 0:
                    totals[key] += value
            rejected = status.get('rejected', {})
            totals['rejected'] += sum(value for value in rejected.values() if type(value) is int and value >= 0) if isinstance(rejected, dict) else 0
            totals['truncated_sources'] += int(status.get('truncated') is True)
            metrics.update({'truncated': status.get('truncated') is True, 'backlog': status.get('backlog', 0)})
            print('Source', source, status.get('state'), 'found', len(jobs), 'new', added,
                  'coverage', json.dumps(metrics, separators=(',', ':')), flush=True)
            if added:
                sent, uncertain = notify(min(deadline,time.monotonic()+30))
                totals['sent'] += sent; totals['uncertain'] += uncertain
        # Expiry corrections reach cloud too. Cloud only updates already-known
        # expired URLs, so this cannot import an archive of old vacancies.
        collect_all(on_source=on_source, include_expired=True, crawl_states=crawl_states,
                    detail_limit=24, page_limit=4)
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
