"""Watchdog completion offers one due-based collection without advertising."""
import contextlib
import io
from pathlib import Path
import re
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'serverless'))
import catch_up


class CatchUpWorkerTests(unittest.TestCase):
    def run_tick(self, response):
        with patch.object(catch_up, 'invoke', return_value=response) as invoke, \
             patch.object(catch_up.collect, 'main') as collect, contextlib.redirect_stdout(io.StringIO()):
            catch_up.main()
        invoke.assert_called_once_with('collection_due')
        return collect.call_count

    def test_overdue_active_collection_gets_one_bounded_attempt(self):
        self.assertEqual(self.run_tick({'active': True, 'due': True, 'running': False}), 1)

    def test_fresh_or_running_collection_is_not_started(self):
        for response in ({'active': True, 'due': False, 'running': False},
                         {'active': True, 'due': True, 'running': True}):
            with self.subTest(response=response):
                self.assertEqual(self.run_tick(response), 0)

    def test_paused_collection_is_not_started(self):
        self.assertEqual(self.run_tick({'active': False, 'due': True, 'running': False}), 0)

    def test_unknown_due_status_fails_before_collection(self):
        with patch.object(catch_up, 'invoke', side_effect=RuntimeError('Unavailable')), \
             patch.object(catch_up.collect, 'main') as collect:
            with self.assertRaisesRegex(RuntimeError, 'Unavailable'): catch_up.main()
        collect.assert_not_called()

    def test_collection_failure_is_reported_without_an_automatic_retry(self):
        with patch.object(catch_up, 'invoke', return_value={'active': True, 'due': True, 'running': False}), \
             patch.object(catch_up.collect, 'main', side_effect=RuntimeError('Collection failed')) as collect, \
             contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaisesRegex(RuntimeError, 'Collection failed'): catch_up.main()
        collect.assert_called_once_with()

    def test_workflow_requires_successful_current_main_watchdog_and_serializes_collection(self):
        text = (ROOT / '.github/workflows/catch-up.yml').read_text()
        self.assertIn('workflows: [Independent bot watchdog]', text)
        self.assertIn('types: [completed]', text)
        self.assertIn('branches: [main]', text)
        self.assertIn("github.event.workflow_run.conclusion == 'success'", text)
        self.assertIn("github.event.workflow_run.event == 'schedule' || github.event.workflow_run.event == 'workflow_dispatch'", text)
        self.assertIn('github.event.workflow_run.head_sha == github.sha', text)
        for path in ('.github/workflows/catch-up.yml', '.github/workflows/serverless.yml'):
            workflow, jobs = (ROOT / path).read_text().split('jobs:', 1)
            self.assertIn('concurrency:\n  group: serbia-jobs-collection\n  queue: max\n  cancel-in-progress: false', workflow)
            self.assertNotIn('concurrency:', jobs)
        self.assertIn('timeout-minutes: 45', text)
        self.assertNotIn('cron:', text)
        self.assertNotIn('ads_worker', text + (ROOT / 'serverless/catch_up.py').read_text())
        self.assertNotIn('Catch up overdue collection', (ROOT / '.github/workflows/backup.yml').read_text())

    def test_workflow_uses_reviewed_action_pins_and_existing_step_scoped_secret(self):
        text = (ROOT / '.github/workflows/catch-up.yml').read_text()
        trusted = (ROOT / '.github/workflows/serverless.yml').read_text()
        self.assertEqual(re.findall(r'uses: (\S+)', text), re.findall(r'uses: (\S+)', trusted))
        self.assertIn('persist-credentials: false', text)
        self.assertIn("node-version: '24'", text)
        self.assertIn("python-version: '3.12'", text)
        self.assertIn('npm ci --ignore-scripts --no-audit --no-fund', text)
        self.assertIn('actions: read', text)
        self.assertIn("CLOUD_MANAGEMENT_GATE: '1'", text)
        self.assertIn("CLOUD_REQUEST_INTERVAL: '2'", text)
        self.assertIn('GITHUB_TOKEN: ${{ github.token }}', text)
        self.assertEqual(re.findall(r'secrets\.([A-Z_]+)', text), ['TGCLOUD_PROBE_TOKEN'])
        before, operation = text.split('      - name: Collect only when overdue', 1)
        self.assertNotIn('TGCLOUD_TOKEN', before)
        self.assertIn('run: python3 serverless/catch_up.py', operation)
        self.assertIn('TGCLOUD_TOKEN: ${{ secrets.TGCLOUD_PROBE_TOKEN }}', operation)


if __name__ == '__main__': unittest.main()
