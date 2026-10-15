"""Read at most two public sources into a three-job probe payload; no user DB."""
import argparse
from dataclasses import asdict
from datetime import datetime, timezone
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from addresses import maps_url
from filters import active, freshness_matches, serbia_eligible
from sources import SOURCES, collect_source

PROBE_SOURCES = ('tg_rabotavserbii', 'tg_radim_serbia')


def make_payload(jobs, limit=3):
    if not 1 <= limit <= 3:
        raise ValueError('Probe accepts 1–3 vacancies')
    selected, seen = [], set()
    now = datetime.now(timezone.utc)
    for job in jobs:
        data = asdict(job) if hasattr(job, '__dataclass_fields__') else dict(job)
        key = (data.get('source'), data.get('url'))
        if key in seen or not active(data, now) or not freshness_matches(data, 'any', now) or not serbia_eligible(data):
            continue
        seen.add(key)
        selected.append({
            'source': str(data['source']), 'url': str(data['url']),
            'title': str(data.get('title') or '')[:180],
            'company': str(data.get('company') or '')[:150],
            'location': str(data.get('location') or '')[:250],
            'description': str(data.get('description') or '')[:800],
            'published_at': str(data.get('published_at') or '')[:60],
            'map_url': maps_url(data) or '',
        })
        if len(selected) == limit:
            break
    if not selected:
        raise ValueError('No eligible live vacancies; cloud import was not started')
    return {'jobs': selected}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=Path(__file__).with_name('payload.json'))
    args = parser.parse_args()
    found = []
    for source in PROBE_SOURCES:
        jobs, status = collect_source(SOURCES[source])
        print(f'{source}: {status["state"]}, {len(jobs)} jobs')
        found.extend(jobs)
        if len(found) >= 3:
            break
    payload = make_payload(found)
    args.output.write_text(json.dumps(payload, ensure_ascii=False), encoding='utf-8')
    print(f'Exported {len(payload["jobs"])} public vacancies')


if __name__ == '__main__':
    main()
