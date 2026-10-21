"""Temporary read-only release diagnostics; no sends or database writes."""
import json
from cloud import invoke

if __name__ == '__main__':
    print('Release progress:',json.dumps(invoke('release_state')),flush=True)
