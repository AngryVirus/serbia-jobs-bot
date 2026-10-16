import contextlib
import copy
import io
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'serverless'))
import refresh_facts


class RefreshFactsTests(unittest.TestCase):
    def test_only_changed_facts_are_sent_and_concurrent_skips_are_reported(self):
        facts = {'quality': {'version': 1, 'reason': None}, 'experience': False, 'paperwork_assistance': None}
        rows = [{'id': 1, '_cloud': copy.deepcopy(facts)}, {'id': 2, '_cloud': {**facts, 'experience': True}}]
        def enrich(row):
            return {**row, '_cloud': copy.deepcopy(facts)}
        def invoke(op, **fields):
            if op == 'export':
                return {'rows': rows}
            self.assertEqual([row['id'] for row in fields['rows']], [2])
            return {'updated': 0, 'skipped': 1}
        output = io.StringIO()
        with patch.object(refresh_facts, 'enrich_job', side_effect=enrich), patch.object(refresh_facts, 'invoke', side_effect=invoke) as calls, contextlib.redirect_stdout(output):
            refresh_facts.refresh()
        self.assertEqual(calls.call_count, 2)
        self.assertEqual(rows[1]['_cloud']['experience'], True)
        self.assertIn('"unchanged": 1', output.getvalue())
        self.assertIn('"concurrent_changes_skipped": 1', output.getvalue())

    def test_unchanged_full_page_still_advances_without_writes(self):
        row = {'id': 1, '_cloud': {'quality': {'version': 1, 'reason': None}}}
        def invoke(op, **fields):
            self.assertEqual(op, 'export')
            return {'rows': [row] * 50 if fields['offset'] == 0 else []}
        with patch.object(refresh_facts, 'enrich_job', side_effect=copy.deepcopy), patch.object(refresh_facts, 'invoke', side_effect=invoke) as calls, contextlib.redirect_stdout(io.StringIO()):
            refresh_facts.refresh()
        self.assertEqual(calls.call_count, 2)
        self.assertEqual(calls.call_args.kwargs['offset'], 50)
