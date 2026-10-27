"""Verify image rendering and the owner's real menu without changing search settings."""
import argparse
import json
from cloud import invoke

if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--preview',action='store_true')
    args=parser.parse_args()
    result=invoke('menu_image_audit')
    if result.get('images',[{},{}])[1].get('icons',0)<2:
        raise RuntimeError('Compact filter category icons were not confirmed')
    if (result.get('home_buttons'),result.get('filter_buttons'))!=(4,6):
        raise RuntimeError('Compact menu controls were not confirmed')
    print(json.dumps(result,sort_keys=True))
    if args.preview:
        print(json.dumps(invoke('menu_image_preview'),sort_keys=True))
