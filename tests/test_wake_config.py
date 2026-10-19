import contextlib
import io
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'serverless'))
import wake_config


class WakeConfigurationTests(unittest.TestCase):
    def test_missing_dedicated_credential_never_contacts_cloud(self):
        with patch.dict(os.environ, {'SJC_WAKE_ENABLED': 'true', 'SJC_GITHUB_WAKE_TOKEN': ''}), \
             patch.object(wake_config, 'invoke') as invoke:
            with self.assertRaisesRegex(RuntimeError, 'dedicated'): wake_config.main()
            invoke.assert_not_called()

    def test_enable_keeps_credential_out_of_output_and_disable_never_sends_it(self):
        value = 'x' * 80
        for enabled in (True, False):
            output = io.StringIO()
            with patch.dict(os.environ, {'SJC_WAKE_ENABLED': str(enabled).lower(), 'SJC_GITHUB_WAKE_TOKEN': value}), \
                 patch.object(wake_config, 'invoke', return_value={'enabled': enabled}) as invoke, \
                 patch.object(wake_config, 'verify_wake_access') as verify, \
                 contextlib.redirect_stdout(output):
                wake_config.main()
            self.assertEqual(verify.call_count, int(enabled))
            self.assertNotIn(value, output.getvalue())
            expected = {'enabled': enabled, **({'credential': value} if enabled else {})}
            invoke.assert_called_once_with('collection_wake_configure', **expected)

    def test_setup_probe_uses_dedicated_key_and_fixed_main_without_reading_response_body(self):
        from unittest.mock import MagicMock
        response = MagicMock(status=204)
        response.__enter__.return_value = response
        with patch.object(wake_config, 'urlopen', return_value=response) as urlopen:
            wake_config.verify_wake_access('x' * 80)
        request = urlopen.call_args.args[0]
        self.assertEqual(request.get_method(), 'POST')
        self.assertEqual(request.full_url, 'https://api.github.com/repos/AngryVirus/serbia-jobs-bot/actions/workflows/catch-up.yml/dispatches')
        self.assertEqual(request.data, b'{"ref": "main"}')
        response.read.assert_not_called()

    def test_failed_probe_does_not_install_credential_or_expose_error_details(self):
        value = 'x' * 80
        with patch.dict(os.environ, {'SJC_WAKE_ENABLED': 'true', 'SJC_GITHUB_WAKE_TOKEN': value}), \
             patch.object(wake_config, 'urlopen', side_effect=OSError(value)), \
             patch.object(wake_config, 'invoke') as invoke:
            with self.assertRaises(RuntimeError) as error: wake_config.main()
            self.assertNotIn(value, str(error.exception))
            invoke.assert_not_called()

    def test_configuration_is_only_explicit_main_dispatch_with_step_scoped_credentials(self):
        root = Path(__file__).resolve().parents[1]
        workflow = (root / '.github/workflows/wake-config.yml').read_text()
        self.assertIn('  workflow_dispatch:', workflow)
        self.assertNotIn('schedule:', workflow)
        self.assertIn("if: github.ref == 'refs/heads/main'", workflow)
        self.assertNotIn('wake_config.py', (root / '.github/workflows/serverless.yml').read_text())
        operation = workflow.split('- name: Configure private runtime credential', 1)[1]
        self.assertIn('secrets.SJC_GITHUB_WAKE_TOKEN', operation)
        self.assertNotIn('secrets.SJC_GITHUB_WAKE_TOKEN', workflow.split('- name: Configure private runtime credential', 1)[0])
