"""Independent watchdog; no collection or advertising sends."""
from cloud import invoke

if __name__ == '__main__':
    invoke('health_tick')
    print('Health check complete')
