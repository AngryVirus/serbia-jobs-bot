"""Verify image rendering and the owner's real menu without changing search settings."""
import argparse
import json
from cloud import invoke

if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--preview',action='store_true')
    args=parser.parse_args()
    result=invoke('menu_image_audit')
    if result.get('images',[{},{}])[1].get('icons')!=9:
        raise RuntimeError('Filter category icons were not confirmed')
    print(json.dumps(result,sort_keys=True))
    if args.preview:
        print(json.dumps(invoke('menu_image_preview'),sort_keys=True))
