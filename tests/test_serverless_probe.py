import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def module(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'serverless-probe' / (name + '.py'))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


exporter = module('export_jobs')
runner = module('run_probe')


class ServerlessProbeTests(unittest.TestCase):
    def test_export_preserves_public_fields_maps_and_limits_without_user_data(self):
        vacancy = {'source': 'radim', 'url': 'https://radim.rs/jobs/cook', 'title': 'Cook',
                   'location': 'Beograd', 'country': 'RS', 'description': 'Address: Knez Mihailova 12',
                   'chat_id': 999, 'settings': {'private': 'not exported'}}
        jobs = [dict(vacancy, country='DE'), dict(vacancy, expires_at='2000-01-01'), vacancy, vacancy]
        jobs += [dict(vacancy, url=f'https://radim.rs/jobs/{i}') for i in range(5)]
        payload = exporter.make_payload(jobs)
        self.assertEqual(len(payload['jobs']), 3)
        self.assertEqual(payload['jobs'][0]['title'], 'Cook')
        self.assertIn('Knez+Mihailova+12', payload['jobs'][0]['map_url'])
        self.assertNotIn('chat_id', json.dumps(payload))
        self.assertNotIn('settings', json.dumps(payload))
        with self.assertRaises(ValueError): exporter.make_payload([])

    def test_configuration_requires_cli_secret_and_numeric_private_chat(self):
        for values in ({}, {'TGCLOUD_TOKEN': 'ordinary-bot-token'},
                       {'TGCLOUD_TOKEN': 'app123:secret', 'PROBE_CHAT_ID': '@AngryVirus'},
                       {'TGCLOUD_TOKEN': 'app123:secret', 'PROBE_CHAT_ID': '-123'}):
            with self.assertRaises(ValueError): runner.read_config(values)
        config = runner.read_config({'TGCLOUD_TOKEN': 'app123:secret', 'PROBE_CHAT_ID': '123'})
        self.assertEqual(config, {'chatId': 123, 'botUsername': 'SerbiaJobsBot', 'recipientUsername': 'AngryVirus'})
        self.assertNotIn('secret', str(config))

    def test_driver_uses_separate_invocations_and_checks_repeat_and_persistence(self):
        sent, operations, pauses = set(), [], []
        def call(operation, config, jobs):
            operations.append(operation)
            rows = [{'stored': True, 'matches': True, 'state': 'sent'} for _ in jobs]
            count = 0
            if operation == 'import':
                self.assertEqual(len(jobs), 1)
                count = int(jobs[0]['id'] not in sent)
                sent.add(jobs[0]['id'])
            return {'rows': rows, 'sent': count}
        result = runner.exercise({}, [{'id': 1}, {'id': 2}], call, pauses.append)
        self.assertTrue(result['ok'])
        self.assertEqual(operations, ['prepare', 'import', 'import', 'verify', 'import', 'import'])
        self.assertEqual(pauses, [1.1, 1.1])
        self.assertEqual(sum(r['sent'] for r in result['repeats']), 0)
        with self.assertRaises(RuntimeError):
            runner.assert_persisted({'rows': [{'stored': True, 'matches': True, 'state': 'uncertain'}]}, 1)

    def test_driver_rejects_duplicate_send(self):
        def call(operation, config, jobs):
            return {'sent': 1, 'rows': [{'stored': True, 'matches': True, 'state': 'sent'}]}
        with self.assertRaisesRegex(RuntimeError, 'Duplicate'):
            runner.exercise({}, [{'id': 1}], call, lambda seconds: None)

    def test_cli_run_only_and_no_debug_or_custom_api_endpoint(self):
        result = SimpleNamespace(returncode=0, stdout='  SJ_PROBE_RESULT:{"sent":0}  +3ms\n', stderr='')
        env = {'TGCLOUD_TOKEN': 'app123:secret', 'TGCLOUD_DEBUG': '1',
               'TG_CLOUD_API_URL': 'https://wrong.example', 'TGCLOUD_BETA': '1'}
        with patch.dict(runner.os.environ, env), patch.object(runner.subprocess, 'run', return_value=result) as run:
            self.assertEqual(runner.invoke('verify', {}, []), {'sent': 0})
        args, kwargs = run.call_args
        self.assertEqual(args[0][2:4], ['run', 'endpoints/probe'])
        self.assertEqual(args[0][-2:], ['--ctx', '{"probeRun":true}'])
        self.assertNotIn('secret', str(args))
        for name in ('TGCLOUD_DEBUG', 'TG_CLOUD_API_URL', 'TGCLOUD_BETA'):
            self.assertNotIn(name, kwargs['env'])

    def test_result_parser_ignores_marker_inside_arguments(self):
        self.assertEqual(runner.parse_result('> probe({text:"SJ_PROBE_RESULT:{bad}"})\n  SJ_PROBE_RESULT:{"ok":true}  +3ms'), {'ok': True})
        with self.assertRaises(RuntimeError): runner.parse_result('> probe({text:"SJ_PROBE_RESULT:{}"})')


if __name__ == '__main__':
    unittest.main()
