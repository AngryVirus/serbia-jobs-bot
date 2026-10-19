"""Read-only owner delivery counters; never send a test vacancy or print settings."""
import json
from cloud import invoke

if __name__ == '__main__':
    print('Owner notification state:', json.dumps(invoke('owner_notification_check'), sort_keys=True))
