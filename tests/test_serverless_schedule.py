"""Delayed cron slots still collect when due; ads remain explicitly confirmed work."""
import contextlib
import io
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'serverless'))
import scheduled


class ScheduledWorkerTests(unittest.TestCase):
    def run_tick(self, response):
        with patch.object(scheduled, 'invoke', return_value=response) as invoke, \
             patch.object(scheduled.collect, 'main') as collect, \
             patch.object(scheduled.ads_worker, 'main') as ads, contextlib.redirect_stdout(io.StringIO()):
            scheduled.main()
        invoke.assert_called_once_with('collection_due')
        return collect.call_count, ads.call_count

    def test_any_scheduled_slot_catches_up_when_collection_is_overdue(self):
        self.assertEqual(self.run_tick({'active': True, 'due': True, 'running': False}), (1, 1))

    def test_fresh_or_already_running_collection_is_not_started_again(self):
        for response in ({'active': True, 'due': False}, {'active': True, 'due': True, 'running': True}):
            self.assertEqual(self.run_tick(response), (0, 1))

    def test_paused_runtime_never_starts_collection_or_advertising(self):
        self.assertEqual(self.run_tick({'active': False, 'due': True}), (0, 0))

    def test_unknown_due_status_fails_closed_before_workers(self):
        with patch.object(scheduled, 'invoke', side_effect=RuntimeError('Unavailable')), \
             patch.object(scheduled.collect, 'main') as collect, patch.object(scheduled.ads_worker, 'main') as ads:
            with self.assertRaises(RuntimeError): scheduled.main()
        collect.assert_not_called(); ads.assert_not_called()

    def test_workflow_uses_one_due_based_schedule_and_verifies_live_collection_after_deploy(self):
        text = (Path(__file__).resolve().parents[1] / '.github/workflows/serverless.yml').read_text()
        self.assertEqual(text.count('    - cron:'), 1)
        self.assertIn('scheduled) python3 serverless/scheduled.py', text)
        self.assertNotIn("github.event.schedule ==", text)
        deploy = text.split('            deploy)', 1)[1].split('              ;;', 1)[0]
        self.assertIn('python3 serverless/collect.py', deploy)


if __name__ == '__main__': unittest.main()
