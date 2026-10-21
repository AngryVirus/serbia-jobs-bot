"""Production validation stays bounded and never logs private gateway details."""
import contextlib
import io
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'serverless'))
import operations_check


class OperationsChecks(unittest.TestCase):
    def test_all_four_bounded_sections_are_required(self):
        def result(operation, section):
            self.assertEqual(operation, 'operations_check')
            return {'section':section,'panels':{'owner':9,'analytics':6,'personal':4,'staff':7}[section],
                    'failed':False,'freshness_warning':False,'backup_verified':True}
        output=io.StringIO()
        with patch.object(operations_check,'invoke',side_effect=result) as call, contextlib.redirect_stdout(output):
            operations_check.main()
        self.assertEqual(call.call_count,4)
        self.assertEqual(json.loads(output.getvalue().splitlines()[-1]),{'panels':26,'sections':4,'freshness_warning':False,'backup_verified':True})

    def test_failed_or_incomplete_sections_stop_before_a_false_success(self):
        for response in [{'failed':True,'reason':'image_size','section':'owner','panels':2},
                         {'failed':False,'section':'owner','panels':6},
                         {'failed':False,'section':'other','panels':7}]:
            with self.subTest(response=response), patch.object(operations_check,'invoke',return_value=response) as call, contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaisesRegex(RuntimeError,'owner'):operations_check.main()
                self.assertEqual(call.call_count,1)

    def test_unexpected_error_details_are_not_printed(self):
        output=io.StringIO()
        with patch.object(operations_check,'invoke',return_value={'failed':True,'reason':'private detail','unexpected_field':'private detail','panels':'private detail'}), contextlib.redirect_stdout(output):
            with self.assertRaisesRegex(RuntimeError,'unconfirmed'):operations_check.main()
        self.assertNotIn('private detail',output.getvalue())

