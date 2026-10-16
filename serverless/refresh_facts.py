"""Refresh derived facts for existing public jobs without replacing source data."""
import json
from cloud import invoke
from enrich_jobs import enrich_job


def refresh():
    offset, updated, skipped = 0, 0, 0
    while True:
        rows = invoke('export', table='jobs', offset=offset, limit=50)['rows']
        if not rows:
            break
        enriched = [enrich_job(row) for row in rows]
        for start in range(0, len(enriched), 25):
            batch = [{key: row.get(key) for key in ('id', 'title', 'description', 'updated_at', '_withdrawn_at', '_cloud')} for row in enriched[start:start+25]]
            result = invoke('refresh_facts', rows=batch)
            updated += result['updated']; skipped += result['skipped']
        offset += len(rows)
        if len(rows) < 50:
            break
    print('Public job facts refreshed:', json.dumps({'updated': updated, 'concurrent_changes_skipped': skipped}))


if __name__ == '__main__':
    refresh()
