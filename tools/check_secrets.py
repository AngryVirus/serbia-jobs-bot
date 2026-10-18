"""Scan tracked files without printing detected values or sending them for verification."""
import json
import subprocess
import sys

files = subprocess.check_output(['git', 'ls-files', '-z']).decode().split('\0')
result = subprocess.run([sys.executable, '-m', 'detect_secrets', 'scan', '--no-verify',
                         *filter(None, files)], text=True, capture_output=True)
if result.returncode:
    raise SystemExit('Secret scanner failed; private output withheld')
findings = json.loads(result.stdout)['results']
if findings:
    for filename, entries in findings.items():
        print(filename, 'lines:', ', '.join(str(item['line_number']) for item in entries))
    raise SystemExit('Potential secrets found; values withheld')
print('Secret scan passed')
