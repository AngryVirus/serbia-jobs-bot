"""The source release must work from a clean directory without tokens or git."""
import importlib.util
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('build_release', ROOT / 'tools/build_release.py')
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)


class SourceReleaseTests(unittest.TestCase):
    def test_incomplete_sources_and_unsafe_output_fail_before_writing(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            readme = root / 'README.md'
            readme.write_text('source fixture')
            with self.assertRaisesRegex(ValueError, 'ZIP file'):
                release.build_release(root, readme)
            self.assertEqual(readme.read_text(), 'source fixture')
            with self.assertRaisesRegex(RuntimeError, 'Incomplete source release'):
                release.build_release(root, root / 'incomplete.zip')
            self.assertFalse((root / 'incomplete.zip').exists())

    def test_complete_deterministic_archive_and_offline_unpacked_runtime(self):
        with tempfile.TemporaryDirectory() as temporary:
            temporary = Path(temporary)
            first, second = temporary / 'one.zip', temporary / 'two.zip'
            self.assertEqual(release.build_release(ROOT, first), release.build_release(ROOT, second))
            self.assertEqual(first.read_bytes(), second.read_bytes())
            with ZipFile(first) as archive:
                names = {name.removeprefix(release.PREFIX) for name in archive.namelist()}
                self.assertTrue(release.REQUIRED <= names)
                current_modules = {p.relative_to(ROOT).as_posix() for p in (ROOT / 'serverless/tgcloud').rglob('*.js')}
                self.assertTrue(current_modules <= names)
                self.assertNotIn('.github/workflows/collect.yml', names)
                archive.extractall(temporary / 'unpacked')
            unpacked = temporary / 'unpacked/serbia-jobs-bot'
            self.assertFalse((unpacked / '.git').exists())
            rebuilt = subprocess.run([sys.executable, 'tools/build_release.py', '--output', str(temporary / 'rebuilt.zip')],
                                     cwd=unpacked, capture_output=True, text=True, timeout=30)
            self.assertEqual(rebuilt.returncode, 0, rebuilt.stderr)
            self.assertEqual(first.read_bytes(), (temporary / 'rebuilt.zip').read_bytes())
            imports = "import sys;sys.path.insert(0,'serverless');import backup,deploy,health_check,menu_check,operations_check;import bot"
            checked = subprocess.run([sys.executable, '-c', imports], cwd=unpacked,
                                     capture_output=True, text=True, timeout=30)
            self.assertEqual(checked.returncode, 0, checked.stderr)
            if shutil.which('node'):
                smoke = """import {fixture,message,handle} from './serverless/tests/fixtures.js';
const f=await fixture();await handle(f,message(12345,'/start'));
if(!f.api.sent.length)throw new Error('No mocked welcome panel');
if(!(await f.store.user(12345)))throw new Error('Profile was not saved');
"""
                checked = subprocess.run(['node', '--input-type=module', '-e', smoke], cwd=unpacked,
                                         capture_output=True, text=True, timeout=30)
                self.assertEqual(checked.returncode, 0, checked.stderr)

    def test_private_files_and_unrelated_artifacts_never_enter_manifest(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            permitted = ['bot.py', '.env.example', 'serverless/new_worker.py',
                         'serverless/tgcloud/lib/new-feature.js', 'tools/licenses/new.txt']
            forbidden = ['.env', 'serverless/.env.local', 'serverless/private/secret.py',
                         'serverless/node_modules/example/index.js', 'work/scratch.py',
                         'data/export.py', '.git/hooks/hook.py', 'serverless/report.json',
                         'serverless/credentials.json', 'serbia-jobs-bot.zip', 'dist/build.py']
            for name in permitted + forbidden:
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('synthetic fixture')
            self.assertEqual({p.relative_to(root).as_posix() for p in release.source_files(root)}, set(permitted))
            (root / 'serverless/escape.py').symlink_to(root / 'work/scratch.py')
            with self.assertRaisesRegex(RuntimeError, 'symlinks'):
                release.source_files(root)


if __name__ == '__main__':
    unittest.main()
