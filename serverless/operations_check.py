"""Read-only production validation of new owner panels and freshness, without sends."""
import json
from cloud import invoke

if __name__ == '__main__':
    result = invoke('operations_check')
    print(json.dumps(result, sort_keys=True))
