"""One bounded collection opportunity after the independent watchdog completes."""
import sys
from cloud import invoke
import collect


def main():
    due = invoke('collection_due')
    if not due.get('active'):
        print('Catch-up skipped: bot is paused')
        return
    if not due.get('due') or due.get('running'):
        print('Catch-up skipped: collection is fresh or already running')
        return
    print('Catch-up collection is due; resuming bounded source positions', flush=True)
    collect.main()


if __name__ == '__main__':
    try:
        main()
    except (ValueError, RuntimeError, OSError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
