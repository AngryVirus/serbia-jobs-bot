"""Read-only diagnostics of paused adapters from the actual collection runner."""
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from sources import SOURCES, collect_source
from source_policy import DISABLED_SITES


def check(key):
    jobs, status = collect_source(SOURCES[key], detail_limit=2)
    return {'source': key, 'jobs': len(jobs), 'state': status['state'], 'detail': status.get('detail')}


if __name__ == '__main__':
    with ThreadPoolExecutor(max_workers=3) as pool:
        for result in pool.map(check, sorted(DISABLED_SITES)):
            print(json.dumps(result, ensure_ascii=False), flush=True)
