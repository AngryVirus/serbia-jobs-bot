"""Resume only owner-confirmed advertising campaigns; never creates a campaign."""
import time
from cloud import invoke


def main():
    deadline = time.monotonic() + 180
    batches = 0
    while time.monotonic() < deadline:
        result = invoke('ads_tick')
        batches += 1
        if result.get('done') or result.get('busy'):
            break
        delay = max(1.1, result.get('retry_after', 0))
        if delay > 30 or time.monotonic() + delay >= deadline:
            break
        time.sleep(delay)
    print('Advertising queue checked; batches:', batches)


if __name__ == '__main__':
    main()
