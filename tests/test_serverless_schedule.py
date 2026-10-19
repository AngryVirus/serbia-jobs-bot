"""Delayed cron slots still collect when due; ads remain explicitly confirmed work."""
import contextlib
import io
import os
from pathlib import Path
import subprocess
import sys
import tempfile
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

    def release_trace(self, failed_script):
        text = (Path(__file__).resolve().parents[1] / '.github/workflows/serverless.yml').read_text()
        commands = text.split('            deploy)', 1)[1].split('              ;;', 1)[0]
        # Run the actual release commands with a fake Python entrypoint, never
        # invoking Cloud or delivering messages. GitHub run steps use bash -e.
        stub = '''python3() {
  printf '%s\\n' "$1" >> "$SJC_TEST_TRACE"
  test "$1" != "$SJC_TEST_FAILURE"
}
'''
        with tempfile.TemporaryDirectory() as temporary:
            trace = Path(temporary) / 'trace'
            result = subprocess.run(['bash', '-e', '-c', stub + commands],
                                    env=dict(os.environ, SJC_TEST_TRACE=str(trace),
                                             SJC_TEST_FAILURE=failed_script),
                                    capture_output=True, text=True, timeout=10)
            return result.returncode, trace.read_text().splitlines()

    def test_screen_diagnostic_failure_does_not_prevent_collection(self):
        for script in ('health_check.py', 'operations_check.py', 'menu_check.py', 'notification_check.py'):
            with self.subTest(script=script):
                code, trace = self.release_trace('serverless/' + script)
                self.assertNotEqual(code, 0)
                self.assertEqual(trace.count('serverless/collect.py'), 1)
                self.assertLess(trace.index('serverless/collect.py'), trace.index('serverless/' + script))
                self.assertNotIn('serverless/ads_worker.py', trace)

    def test_unsafe_deploy_or_failed_fact_refresh_never_runs_collection(self):
        for script in ('deploy.py', 'refresh_facts.py'):
            with self.subTest(script=script):
                code, trace = self.release_trace('serverless/' + script)
                self.assertNotEqual(code, 0)
                self.assertNotIn('serverless/collect.py', trace)

    def test_collection_failure_still_fails_publication(self):
        code, trace = self.release_trace('serverless/collect.py')
        self.assertNotEqual(code, 0)
        self.assertNotIn('serverless/operations_check.py', trace)


if __name__ == '__main__': unittest.main()
