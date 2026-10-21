"""Temporary read-only release diagnostics; no sends or database writes."""
import json
from cloud import invoke
from refresh_facts import facts_version

if __name__ == '__main__':
    # The originating run 39689380695 is confirmed completed/cancelled. Match
    # its exact lease expiry and facts version; a renewed lease cannot be removed.
    print('Ended-run facts lease:',json.dumps(invoke('release_finished_facts',
          expires=1792626352698,version=facts_version())),flush=True)
