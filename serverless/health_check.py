"""Temporary read-only release diagnostics; no sends or database writes."""
import hashlib
import json
from pathlib import Path
from cloud import invoke, call

if __name__ == '__main__':
    remote=call('remote').get('canonical_modules',{})
    root=Path(__file__).parent/'tgcloud'
    local={p.relative_to(root).with_suffix('').as_posix():p.read_text() for p in root.rglob('*.js')}
    print('Release runtime:',json.dumps({'matches_expected':remote==local,'modules':len(remote),
          'digest':hashlib.sha256(json.dumps(remote,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()}),flush=True)
    status=invoke('status')
    print('Release status:',json.dumps({'active':status['active'],'counts':status['counts']}),flush=True)
    facts=invoke('facts_status');progress=facts.get('progress') or {}
    print('Release facts:',json.dumps({'in_progress':bool(progress),'after':progress.get('after'),
          'upper':progress.get('upper'),'started_at':progress.get('started_at')}),flush=True)
