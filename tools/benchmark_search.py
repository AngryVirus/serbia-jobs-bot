"""Measure real viewer/filter code on synthetic catalogs without external APIs.

Run from the repository: python3 tools/benchmark_search.py
SQLite is real. Supabase pagination uses an in-process JSON transport, with an
optional --page-delay-ms to model latency per page (not a production measurement).
Telegram delivery, webhook handling, and concurrent users are not measured.
"""
import argparse
import asyncio
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import platform
import statistics
import sys
import tempfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from bot import Bot
from cloud_store import SupabaseStore
from store import Store, default_settings
from viewer import show


class LocalAPI:
    def __init__(self):
        self.text = ''

    async def call(self, method, **params):
        assert method == 'editMessageText'
        self.text = params['text']


class CatalogTransport(SupabaseStore):
    """Exercise SupabaseStore.list_jobs/_rows with JSON pages, without HTTP."""
    def __init__(self, rows, page_delay_ms):
        self.rows = rows
        self.delay = page_delay_ms / 1000
        self.pages = 0

    def _request(self, method, table, params=None, data=None, prefer=None):
        assert method == 'GET' and table == 'sj_jobs'
        assert params['order'] == 'created_at.desc,id.desc'
        self.pages += 1
        if self.delay:
            time.sleep(self.delay)
        offset, limit = params['offset'], params['limit']
        return json.loads(json.dumps(self.rows[offset:offset + limit], ensure_ascii=False))


def fixtures(size):
    published = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
    for number in range(1, size + 1):
        developer = number % 2 == 0
        yield {
            'source': 'poslovi', 'url': f'https://www.poslovi.rs/job/{number}',
            'title': f'Python developer {number}' if developer else f'Kuvar {number}',
            'company': 'Benchmark company', 'location': 'Beograd' if developer else 'Nis',
            'description': ('Python development. English required. ' if developer
                            else 'Priprema hrane. Srpski jezik. ') * 30,
            'languages': ['en'] if developer else ['sr'],
            'required_languages': ['en'] if developer else ['sr'],
            'salary_min': 1500, 'salary_currency': 'EUR', 'salary_period': 'month',
            'remote': developer, 'published_at': published, 'country': 'RS',
        }


async def measure(store, size, name, repeats):
    api = LocalAPI()
    bot = Bot(api, store)
    filtered = dict(default_settings(), city=['belgrade'], keywords=['Python'], language=['english'])
    cases = [('search_all', default_settings(), size, {}),
             ('search_filtered', filtered, size // 2, {}),
             ('next_filtered', filtered, size // 2,
              {'job_id': size - size % 2, 'index': 0, 'action': 'next'})]
    for action, settings, expected_count, kwargs in cases:
        # A handler normally supplies this per-request settings snapshot.
        token = bot._request_settings.set((1, settings))
        durations, pages = [], []
        try:
            for iteration in range(repeats + 1):
                before_pages = getattr(store, 'pages', 0)
                start = time.perf_counter()
                await show(bot, 1, 1, mid=1, **kwargs)
                elapsed = (time.perf_counter() - start) * 1000
                position = 2 if action == 'next_filtered' else 1
                assert f'Вакансия {position} из {expected_count}' in api.text, api.text
                if iteration:  # Exclude one warm-up per case.
                    durations.append(elapsed)
                    pages.append(getattr(store, 'pages', 0) - before_pages)
        finally:
            bot._request_settings.reset(token)
        print(json.dumps({'backend': name, 'jobs': size, 'action': action,
                          'median_ms': round(statistics.median(durations), 2),
                          'min_ms': round(min(durations), 2), 'max_ms': round(max(durations), 2),
                          'catalog_pages': pages[0] if name == 'supabase_model' else None,
                          'repeats': repeats}), flush=True)


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sizes', nargs='+', type=int, default=[1000, 10000, 50000])
    parser.add_argument('--repeats', type=int, default=3)
    parser.add_argument('--page-delay-ms', type=float, default=0)
    args = parser.parse_args()
    if min(args.sizes) < 4 or args.repeats < 1 or args.page_delay_ms < 0:
        parser.error('Sizes must be >=4, repeats >=1 and page delay >=0.')
    print(json.dumps({'python': platform.python_version(), 'platform': platform.system(),
                      'supabase_mode': 'in-process JSON pages, no HTTP',
                      'page_delay_ms': args.page_delay_ms}), flush=True)
    for size in args.sizes:
        with tempfile.TemporaryDirectory(prefix='serbia-jobs-benchmark-') as directory:
            store = Store(Path(directory) / 'jobs.sqlite3')
            assert store.save_jobs(fixtures(size)) == size
            await measure(store, size, 'sqlite', args.repeats)
            model = CatalogTransport(store.list_jobs(), args.page_delay_ms)
            await measure(model, size, 'supabase_model', args.repeats)


if __name__ == '__main__':
    asyncio.run(main())
