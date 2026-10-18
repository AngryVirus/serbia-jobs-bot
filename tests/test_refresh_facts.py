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
    def test_current_version_uses_one_request_and_never_scans_catalog(self):
        version=refresh_facts.facts_version()
        with patch.object(refresh_facts,'invoke',return_value={'version':version}) as calls, contextlib.redirect_stdout(io.StringIO()):
            refresh_facts.refresh()
        calls.assert_called_once_with('facts_status')

    def test_changed_facts_use_persisted_cursor_and_preserve_unchanged_rows(self):
        facts={'version':1,'languages':['en'],'required_languages':['en']}
        rows=[{'id':51,'_cloud':copy.deepcopy(facts)},{'id':52,'_cloud':{'version':1,'languages':[]}}]
        page=iter([{'rows':rows},{'rows':[]}])
        def invoke(op,**fields):
            if op=='facts_status':return {'version':None}
            if op=='facts_begin':return {'after':50}
            if op=='facts_page':return next(page)
            if op=='facts_apply':
                self.assertEqual(fields['after'],52)
                self.assertEqual([r['id'] for r in fields['rows']],[52])
                return {'updated':0,'skipped':1}
            return {}
        def enrich(row):return {**row,'_cloud':copy.deepcopy(facts)}
        output=io.StringIO()
        with patch.object(refresh_facts,'invoke',side_effect=invoke) as calls, patch.object(refresh_facts,'enrich_job',side_effect=enrich), contextlib.redirect_stdout(output):refresh_facts.refresh()
        self.assertIn('"resumed_after_id": 50',output.getvalue());self.assertIn('"unchanged": 1',output.getvalue())
        self.assertEqual(calls.call_args_list[-2].args,('facts_finish',))
        self.assertEqual(calls.call_args_list[-1].args,('facts_release',))

    def test_processing_failure_releases_lease_without_marking_version_complete(self):
        def invoke(op,**fields):
            if op=='facts_status':return {}
            if op=='facts_begin':return {'after':0}
            if op=='facts_page':raise RuntimeError('read failed')
            return {}
        with patch.object(refresh_facts,'invoke',side_effect=invoke) as calls, self.assertRaisesRegex(RuntimeError,'read failed'):refresh_facts.refresh()
        self.assertNotIn('facts_finish',[c.args[0] for c in calls.call_args_list]);self.assertEqual(calls.call_args.args,('facts_release',))

    def test_cleanup_error_does_not_mask_a_completed_refresh(self):
        def invoke(op,**fields):
            if op=='facts_status':return {}
            if op=='facts_begin':return {'after':0}
            if op=='facts_page':return {'rows':[]}
            if op=='facts_release':raise RuntimeError('cleanup unavailable')
            return {}
        with patch.object(refresh_facts,'invoke',side_effect=invoke),contextlib.redirect_stdout(io.StringIO()):refresh_facts.refresh()
