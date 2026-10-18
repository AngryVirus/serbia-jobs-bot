"""Collection worker uses durable bounded notifications and forwards expiry edits."""
import contextlib
import io
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'serverless'))
import collect
from sources import Job


class CollectionWorkerTests(unittest.TestCase):
    def test_deadline_and_worker_restart_continue_the_cloud_cursor(self):
        clock, cursor, visits = [0.0], [0], []

        def invoke(operation, **fields):
            self.assertEqual((operation, fields), ('notify_batch', {'limit': 10}))
            last = min(70, cursor[0] + fields['limit'])
            visits.extend(range(cursor[0] + 1, last + 1))
            sent = last - cursor[0]
            cursor[0] = last
            return {'sent': sent, 'uncertain': 2, 'done': last == 70}

        with patch.object(collect, 'invoke', side_effect=invoke), \
             patch.object(collect.time, 'monotonic', side_effect=lambda: clock[0]), \
             patch.object(collect.time, 'sleep', side_effect=lambda delta: clock.__setitem__(0, clock[0] + delta)):
            self.assertEqual(collect.notify(clock[0] + 3), (30, 6))
            self.assertEqual(visits, list(range(1, 31)))
            self.assertEqual(collect.notify(clock[0] + 3), (30, 6))
            self.assertEqual(visits, list(range(1, 61)))
            self.assertEqual(collect.notify(clock[0] + 3), (10, 2))
        self.assertEqual(visits, list(range(1, 71)))

    def test_retry_after_busy_or_completed_round_stops_without_replaying_a_batch(self):
        for response in ({'retry_after': 30}, {'busy': True}, {'done': True}):
            with self.subTest(response=response), \
                 patch.object(collect, 'invoke', return_value={'sent': 1, 'uncertain': 2, **response}) as invoke, \
                 patch.object(collect.time, 'monotonic', return_value=1), \
                 patch.object(collect.time, 'sleep') as sleep:
                self.assertEqual(collect.notify(10), (1, 2))
                invoke.assert_called_once_with('notify_batch', limit=10)
                sleep.assert_not_called()

    def test_expired_budget_does_not_start_a_cloud_batch(self):
        with patch.object(collect.time, 'monotonic', return_value=10), patch.object(collect, 'invoke') as invoke:
            self.assertEqual(collect.notify(10), (0, 0))
            invoke.assert_not_called()

    def test_collection_opt_in_uploads_expiry_correction_as_enriched_facts(self):
        job = Job('radim', 'https://radim.rs/jobs/known', 'Support', expires_at='2020-01-01')

        def collect_all(*, on_source, include_expired):
            self.assertTrue(include_expired)
            on_source('radim', [job], {'state': 'ok'})

        def invoke(operation, **fields):
            if operation == 'init':
                return {'active': True}
            if operation == 'collect':
                self.assertEqual(fields['jobs'][0]['expires_at'], '2020-01-01')
                self.assertLess(fields['jobs'][0]['_cloud']['expires_ms'], 1600000000000)
                return {'added': 0}
            return {}

        with patch.object(collect, 'collect_all', side_effect=collect_all), \
             patch.object(collect, 'invoke', side_effect=invoke) as calls, \
             patch.object(collect, 'notify', return_value=(0, 0)), \
             contextlib.redirect_stdout(io.StringIO()):
            collect.main()
        self.assertEqual(calls.call_args.args, ('collection_end',))
        self.assertFalse(calls.call_args.kwargs['failed'])


if __name__ == '__main__':
    unittest.main()
