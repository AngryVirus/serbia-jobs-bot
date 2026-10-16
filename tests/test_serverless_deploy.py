"""An update must preserve the running bot's routing and current database."""
import contextlib
import io
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'serverless'))
import deploy


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        root = Path(deploy.__file__).parent / 'tgcloud'
        self.local = {p.relative_to(root).with_suffix('').as_posix(): p.read_text() for p in root.rglob('*.js')}
        self.old = dict(self.local, **{'lib/bot': '// reviewed old version'})
        self.routing = {'url': 'https://cloud.telegram.org/test', 'allowed_updates': ['message', 'callback_query'], 'in_sync': True}
        self.status = {'active': True, 'ever_active': True, 'counts': {'jobs': 1080}}

    def run_deploy(self, remote_versions, *, status=None, routings=None):
        remotes = iter(remote_versions)
        routes = iter(routings or [self.routing, self.routing])
        def call(command):
            return {'canonical_modules': next(remotes)} if command == 'remote' else next(routes)
        def invoke(op):
            return (status or self.status) if op == 'status' else {'unique': 827}
        with patch.object(deploy, 'PREVIOUS_DIGEST', deploy.digest(self.old)), patch.object(deploy, 'call', side_effect=call), patch.object(deploy, 'invoke', side_effect=invoke) as admin, patch.object(deploy, 'cli') as cli, contextlib.redirect_stdout(io.StringIO()):
            self.last_cli = cli
            deploy.deploy()
        return admin, cli

    def test_reviewed_update_uses_revision_checked_push_no_data_import(self):
        admin, cli = self.run_deploy([self.old, self.old, self.local])
        self.assertEqual([c.args for c in cli.call_args_list], [('fetch',), ('push',)])
        self.assertEqual([c.args for c in admin.call_args_list], [('status',), ('audit',), ('status',)])

    def test_same_release_is_idempotent(self):
        _, cli = self.run_deploy([self.local, self.local])
        cli.assert_not_called()

    def test_unknown_remote_and_concurrent_edit_stop_before_push(self):
        for versions in [[{'handlers/message': 'unknown'}], [self.old, self.local]]:
            with self.subTest(versions=len(versions)):
                with self.assertRaisesRegex(RuntimeError, 'Unexpected deployed|changed during review'):
                    self.run_deploy(versions)
                self.assertNotIn(('push',), [c.args for c in self.last_cli.call_args_list])

    def test_paused_bot_or_changed_routing_cannot_be_reported_as_success(self):
        with self.assertRaisesRegex(RuntimeError, 'active migrated'):
            self.run_deploy([], status={**self.status, 'active': False})
        with self.assertRaisesRegex(RuntimeError, 'Routing changed'):
            self.run_deploy([self.local, self.local], routings=[self.routing, {**self.routing, 'url':'https://elsewhere.invalid/test'}])


if __name__ == '__main__':
    unittest.main()
