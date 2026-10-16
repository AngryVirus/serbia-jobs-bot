"""Refresh derived facts for existing public jobs without replacing source data."""
import json
from cloud import invoke
from enrich_jobs import enrich_job


def refresh():
    offset, updated, skipped, unchanged = 0, 0, 0, 0
    while True:
        rows = invoke('export', table='jobs', offset=offset, limit=50)['rows']
        if not rows:
            break
        enriched = []
        for row in rows:
            fresh = enrich_job(row)
            if all(row.get('_cloud', {}).get(key) == fresh['_cloud'].get(key)
                   for key in ('quality', 'experience', 'paperwork_assistance')):
                unchanged += 1
            else:
                enriched.append(fresh)
        for start in range(0, len(enriched), 25):
            batch = [{key: row.get(key) for key in ('id', 'title', 'description', 'updated_at', '_withdrawn_at', '_cloud')} for row in enriched[start:start+25]]
            result = invoke('refresh_facts', rows=batch)
            updated += result['updated']; skipped += result['skipped']
        offset += len(rows)
        print('Public job facts progress:', json.dumps({'checked': offset, 'updated': updated,
              'unchanged': unchanged, 'concurrent_changes_skipped': skipped}), flush=True)
        if len(rows) < 50:
            break
    print('Public job facts refreshed:', json.dumps({'updated': updated, 'unchanged': unchanged, 'concurrent_changes_skipped': skipped}))


if __name__ == '__main__':
    refresh()
