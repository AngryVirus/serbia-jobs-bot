"""Deterministic ZIP of explicit source files; excludes secrets, databases, caches."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED, ZipInfo
import hashlib

root=Path(__file__).resolve().parents[1]
files=[p for p in root.glob('*.py')]
files += [root/name for name in ('README.md','SOURCE_NOTES.md','START_WITH_IPHONE.md','VALIDATION.md',
    'requirements.txt','requirements-dev.txt','.python-version','.env.example','.gitignore',
    'supabase-schema.sql','render.yaml','collect-workflow.txt')]
for directory in ('tests','tools','deploy','.github/workflows'):
    files += [p for p in (root/directory).glob('*') if p.is_file() and p.suffix in {'.py','.yml','.yaml','.service'}]
files=sorted(set(files),key=lambda p:str(p.relative_to(root)))
target=root/'serbia-jobs-bot.zip'
with ZipFile(target,'w',ZIP_DEFLATED,compresslevel=9) as archive:
    for path in files:
        relative=path.relative_to(root).as_posix()
        if relative=='.env' or '/data/' in '/'+relative or not path.is_file():
            raise RuntimeError('Unexpected release path')
        info=ZipInfo('serbia-jobs-bot/'+relative,date_time=(2026,10,14,0,0,0))
        info.compress_type=ZIP_DEFLATED
        info.external_attr=0o100644 << 16
        archive.writestr(info,path.read_bytes())
with ZipFile(target) as archive:
    assert archive.testzip() is None
    assert all('.env' not in name or name.endswith('.env.example') for name in archive.namelist())
print(f'{len(files)} release files; {target.stat().st_size} bytes; sha256 {hashlib.sha256(target.read_bytes()).hexdigest()}')
