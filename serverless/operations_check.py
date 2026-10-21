"""Read-only production validation of new owner panels and freshness, without sends."""
import json
from cloud import invoke

def main():
    total, stale, backup = 0, False, True
    for section, expected in [('owner', 10), ('analytics', 6), ('personal', 4), ('staff', 7)]:
        result = invoke('operations_check', section=section)
        reason=result.get('reason')
        reason=reason if reason in {'panel_size','callback_size','image_size','execution_limit','execution_error'} else 'unconfirmed'
        count=result.get('panels')
        print('Operations section:', json.dumps({'section':section,'panels':count if type(count) is int and 0<=count<=24 else None,'failed':result.get('failed') is not False,'reason':reason if result.get('failed') is not False else None}, sort_keys=True), flush=True)
        if result.get('failed') is not False or result.get('panels') != expected or result.get('section') != section:
            raise RuntimeError(f'Production screen check failed in {section}: {reason}')
        total += result['panels']
        stale = stale or bool(result.get('freshness_warning'))
        backup = backup and bool(result.get('backup_verified'))
    print(json.dumps({'panels':total,'sections':4,'freshness_warning':stale,'backup_verified':backup}, sort_keys=True))


if __name__ == '__main__':
    main()
