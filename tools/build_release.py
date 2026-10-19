"""Build a reproducible source release, never a database or a deployment.

Usage: python3 tools/build_release.py --output dist/serbia-jobs-bot.zip
The same builder works from an unpacked release without a .git directory.
"""
import argparse
import hashlib
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo


ROOT = Path(__file__).resolve().parents[1]
PREFIX = 'serbia-jobs-bot/'
DIRECTORIES = {'.github', 'deploy', 'serverless', 'serverless-probe', 'tests', 'tools'}
EXCLUDED = {'.git', '.tgcloud', '.venv', '__pycache__', 'node_modules',
            'private', 'data', 'dist', 'work', '.pytest_cache'}
SOURCE_SUFFIXES = {'.py', '.js', '.mjs', '.md', '.sql', '.yml', '.yaml', '.service', '.disabled'}
ROOT_CONFIG = {'.env.example', '.gitignore', '.python-version', 'requirements.txt',
               'requirements-dev.txt'}
REQUIRED = {'README.md', 'SECURITY.md', 'serverless/package.json',
            'serverless/package-lock.json', 'serverless/tgcloud.jsonc',
            'serverless/bridge.mjs', 'serverless/deploy.py', 'serverless/collect.py',
            'serverless/health_check.py', 'serverless/operations_check.py',
            'serverless/menu_check.py', 'serverless/backup.py',
            'serverless/backup_crypto.mjs', 'serverless/restore_check.mjs',
            'serverless/OPERATIONS.md', 'serverless/IMAGE_MENU.md',
            'tools/image-codec-entry.mjs', 'tools/licenses/pako.txt',
            'tools/licenses/dejavu-fonts.txt', '.github/workflows/tests.yml',
            '.github/workflows/serverless.yml', '.github/workflows/backup.yml'}


def source_files(root):
    """Allow source trees and known config types; exclude runtime/private files."""
    root = Path(root)
    files = []
    for path in root.rglob('*'):
        relative = path.relative_to(root)
        if any(part in EXCLUDED for part in relative.parts):
            continue
        if len(relative.parts) > 1 and relative.parts[0] not in DIRECTORIES:
            continue
        name = relative.as_posix()
        allowed = (path.suffix in SOURCE_SUFFIXES or name in ROOT_CONFIG
                   or path.name in {'package.json', 'package-lock.json', 'tgcloud.jsonc'}
                   or (relative.parts[:2] == ('tests', 'fixtures') and path.suffix in {'.html', '.xml', '.json'})
                   or (relative.parts[:2] == ('tools', 'licenses') and path.suffix == '.txt'))
        if not allowed or (name != '.env.example' and any(part.startswith('.env') for part in relative.parts)):
            continue
        if path.is_symlink():
            raise RuntimeError('Source releases cannot contain symlinks: ' + name)
        if path.is_file():
            files.append(path)
    return sorted(files, key=lambda path: path.relative_to(root).as_posix())


def build_release(root, output):
    root, output = Path(root), Path(output)
    if output.suffix.lower() != '.zip' or output.is_symlink():
        raise ValueError('Release output must be a ZIP file, not a source file or symlink')
    files = source_files(root)
    names = {path.relative_to(root).as_posix() for path in files}
    missing = REQUIRED - names
    if missing:
        raise RuntimeError('Incomplete source release: ' + ', '.join(sorted(missing)))
    output.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(output, 'w', ZIP_DEFLATED, compresslevel=9) as archive:
        for path in files:
            info = ZipInfo(PREFIX + path.relative_to(root).as_posix(), (2026, 10, 14, 0, 0, 0))
            info.compress_type = ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, path.read_bytes(), compresslevel=9)
    with ZipFile(output) as archive:
        if archive.testzip() is not None:
            raise RuntimeError('Source release integrity check failed')
    return len(files), hashlib.sha256(output.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / 'dist' / 'serbia-jobs-bot.zip')
    args = parser.parse_args()
    count, digest = build_release(ROOT, args.output)
    print(f'{count} source files; {args.output.stat().st_size} bytes; sha256 {digest}')


if __name__ == '__main__':
    main()
