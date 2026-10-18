"""Old entrypoints must never take production routing by an ordinary restart."""
import contextlib
import io
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import bot


class LegacyStartupTests(unittest.TestCase):
    def test_polling_and_webhook_are_disabled_before_store_or_network_initialization(self):
        for args in [[], ['--webhook']]:
            with self.subTest(args=args), patch.object(sys, 'argv', ['bot.py', *args]), \
                    patch.dict(os.environ, {}, clear=True), patch.object(bot, 'load_env'), \
                    patch.object(bot, 'Store') as store, contextlib.redirect_stderr(io.StringIO()) as errors:
                with self.assertRaises(SystemExit) as failure:
                    bot.main()
                self.assertEqual(failure.exception.code, 2)
                self.assertIn('Legacy polling/webhook is disabled', errors.getvalue())
                store.assert_not_called()

    def test_imports_and_readonly_status_do_not_need_runtime_opt_in(self):
        with patch.object(sys, 'argv', ['bot.py', '--status']), patch.dict(os.environ, {}, clear=True), \
                patch.object(bot, 'load_env'), patch.object(bot, 'Store') as store:
            store.return_value.source_status.return_value = {}
            bot.main()
            store.assert_called_once()

    def test_explicit_legacy_opt_in_reaches_validation_without_contacting_telegram(self):
        with patch.object(sys, 'argv', ['bot.py']), \
                patch.dict(os.environ, {'SERBIA_JOBS_ALLOW_LEGACY_RUNTIME': '1'}, clear=True), \
                patch.object(bot, 'load_env'), patch.object(bot, 'Store') as store, \
                contextlib.redirect_stderr(io.StringIO()) as errors:
            with self.assertRaises(SystemExit):
                bot.main()
            store.assert_called_once()
            self.assertIn('Set TELEGRAM_BOT_TOKEN', errors.getvalue())


if __name__ == '__main__':
    unittest.main()
