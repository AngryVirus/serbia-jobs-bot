"""Every scheduled tick can catch up an overdue collection before queue work."""
import sys
from cloud import invoke
import collect
import ads_worker


def main():
    due = invoke('collection_due')
    if not due.get('active'):
        print('Scheduled work skipped: bot is paused')
        return
    if due.get('due') and not due.get('running'):
        print('Scheduled collection is due; resuming bounded source positions', flush=True)
        collect.main()
    else:
        print('Collection is fresh or already running; checking confirmed queues', flush=True)
    # This resumes only campaigns the owner has already confirmed. Vacancy
    # delivery and advertising retain their separate queues and safeguards.
    ads_worker.main()


if __name__ == '__main__':
    try:
        main()
    except (ValueError, RuntimeError, OSError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
