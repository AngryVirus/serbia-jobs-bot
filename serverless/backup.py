"""Encrypted, consistent application SQLite backup and isolated recovery drill."""
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import uuid
from cloud import environment, invoke

ROOT = Path(__file__).resolve().parent
SCHEMA = {
    'sjc_meta': 'key TEXT PRIMARY KEY, payload TEXT NOT NULL',
    'sjc_users': 'id INTEGER PRIMARY KEY, payload TEXT NOT NULL',
    'sjc_jobs': 'id INTEGER PRIMARY KEY AUTOINCREMENT, source_key TEXT NOT NULL UNIQUE, payload TEXT NOT NULL',
    'sjc_deliveries': 'user_id INTEGER NOT NULL, job_id INTEGER NOT NULL, state TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(user_id,job_id)',
    'sjc_records': 'kind TEXT NOT NULL, record_key TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(kind,record_key)',
    'sjc_updates': 'key TEXT PRIMARY KEY, state TEXT NOT NULL, expires INTEGER NOT NULL',
    'sjc_locks': 'key TEXT PRIMARY KEY, owner TEXT NOT NULL, expires INTEGER NOT NULL',
}
TABLES = (*[t for t in SCHEMA if t != 'sjc_locks'], 'sqlite_sequence')


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def digest(rows):
    return hashlib.sha256(canonical({t: sorted(canonical(r) for r in rows.get(t, [])) for t in TABLES}).encode()).hexdigest()


def build_database(rows):
    if set(rows) != set(TABLES):
        raise ValueError('Incomplete backup table manifest')
    db = sqlite3.connect(':memory:')
    for table, definition in SCHEMA.items():
        db.execute(f'CREATE TABLE {table} ({definition})')
    # Insert jobs first; its saved autoincrement sequence is restored last.
    for table in TABLES:
        if table == 'sqlite_sequence':
            db.execute('DELETE FROM sqlite_sequence')
        allowed = {r[1] for r in db.execute(f'PRAGMA table_info({table})')}
        for row in rows[table]:
            if set(row) != allowed:
                raise ValueError('Unexpected backup columns')
            columns = sorted(row)
            db.execute(f"INSERT INTO {table} ({','.join(columns)}) VALUES ({','.join('?' for _ in columns)})", [row[c] for c in columns])
    db.commit()
    if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
        raise ValueError('Backup database integrity failed')
    return db


def read_database(db):
    db.row_factory = sqlite3.Row
    return {table: [dict(r) for r in db.execute(f'SELECT * FROM {table}')] for table in TABLES}


def crypt(data, mode, env=None):
    result = subprocess.run(['node', str(ROOT/'backup_crypto.mjs'), mode], input=data,
                            env=environment() if env is None else env, capture_output=True, timeout=60)
    if result.returncode:
        raise RuntimeError('Backup encryption/authentication failed; no private data logged')
    return result.stdout


def restore_drill(encrypted, expected_digest=None, env=None):
    clear = gzip.decompress(crypt(encrypted, 'decrypt', env))
    db = sqlite3.connect(':memory:')
    db.deserialize(clear)
    if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
        raise ValueError('Restored SQLite integrity failed')
    rows = read_database(db)
    actual = digest(rows)
    if expected_digest is not None and actual != expected_digest:
        raise ValueError('Full-record recovery comparison failed')
    with tempfile.TemporaryDirectory(prefix='sj-recovery-') as directory:
        path = Path(directory)/'restored.sqlite'
        path.write_bytes(clear);path.chmod(0o600)
        # No cloud credential is inherited by the offline application smoke test.
        safe_env = {k: v for k, v in os.environ.items() if k not in ('TGCLOUD_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN')}
        result = subprocess.run(['node', str(ROOT/'restore_check.mjs'), str(path)],
                                capture_output=True, env=safe_env, timeout=60)
        if result.returncode:
            raise RuntimeError('Offline restored-bot validation failed; private output withheld')
    db.close()
    return {'integrity': True, 'full_record_digest': actual, 'offline_bot': True,
            'counts': {t: len(v) for t, v in rows.items()}, 'sends': 0}


def create_backup(output):
    identifier = str(uuid.uuid4())
    manifest = invoke('backup_create', id=identifier)
    try:
        if manifest.get('version') != 1 or set(manifest.get('counts', {})) != set(TABLES):
            raise ValueError('Invalid cloud snapshot manifest')
        rows = {}
        for table in TABLES:
            values = []
            while len(values) < manifest['counts'][table]:
                page = invoke('backup_page', id=identifier, table=table, offset=len(values))['rows']
                if not page:
                    raise ValueError('Incomplete immutable snapshot')
                values.extend(page)
            if len(values) != manifest['counts'][table]:
                raise ValueError('Snapshot count mismatch')
            rows[table] = values
        db = build_database(rows)
        encrypted = crypt(gzip.compress(db.serialize(), mtime=0), 'encrypt');db.close()
        report = restore_drill(encrypted, digest(rows))
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(encrypted);output.chmod(0o600)
        # Re-read the actual artifact, rather than checking only the in-memory value.
        verified = restore_drill(output.read_bytes(), report['full_record_digest'])
        output.with_suffix('.report.json').write_text(canonical({'version': 1, **verified})+'\n')
        print('Encrypted backup saved; isolated full-record recovery and offline bot checks passed')
    finally:
        invoke('backup_release', id=identifier)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['create', 'verify', 'restore-local', 'confirm'])
    parser.add_argument('path', type=Path)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    if args.action == 'confirm':
        report=json.loads(args.path.with_suffix('.report.json').read_text())
        if not report.get('integrity') or not report.get('offline_bot'):
            raise ValueError('Verified report required')
        invoke('backup_status', verified=True, counts=report['counts'])
        print('Uploaded backup recorded')
    elif args.action == 'create':
        create_backup(args.path)
    else:
        report = restore_drill(args.path.read_bytes())
        if args.action == 'restore-local':
            if args.output is None or args.output.exists():
                raise ValueError('Provide a new --output path; overwriting is forbidden')
            clear = gzip.decompress(crypt(args.path.read_bytes(), 'decrypt'))
            db = sqlite3.connect(':memory:');db.deserialize(clear)
            # Recovery is always paused; never resume a historical advertising queue.
            db.execute("UPDATE sjc_meta SET payload='false' WHERE key='active'")
            db.execute("INSERT INTO sjc_meta(key,payload) VALUES('ad_emergency',?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload", (str(2**53-1),))
            db.commit();args.output.write_bytes(db.serialize());args.output.chmod(0o600);db.close()
        print(canonical(report))


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, ValueError, OSError, sqlite3.Error):
        raise SystemExit('Backup/recovery failed; private details withheld') from None
