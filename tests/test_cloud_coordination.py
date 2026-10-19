"""Management queue coordination uses only read-only GitHub metadata."""
import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'serverless'))
import cloud


class CoordinationTests(unittest.TestCase):
    def setUp(self):
        self.env={'CLOUD_MANAGEMENT_GATE':'1','GITHUB_RUN_ID':'200'}

    def test_earlier_maintenance_waits_but_self_and_later_runs_do_not(self):
        earlier={'id':100,'path':'.github/workflows/backup.yml'}
        safe=[{'id':200,'path':'.github/workflows/serverless.yml'},
              {'id':300,'path':'.github/workflows/backup.yml'}]
        with patch.object(cloud,'running_workflows',side_effect=[[earlier,*safe],safe]) as reads, patch.object(cloud.time,'sleep') as sleep, contextlib.redirect_stderr(io.StringIO()):
            cloud.management_turn(self.env)
        self.assertEqual(reads.call_count,2);sleep.assert_called_once_with(15)

    def test_normal_work_yields_to_later_watchdog_but_watchdog_never_waits(self):
        watchdog={'id':300,'path':'.github/workflows/health.yml'}
        with patch.object(cloud,'running_workflows',side_effect=[[watchdog],[]]),patch.object(cloud.time,'sleep') as sleep,contextlib.redirect_stderr(io.StringIO()):
            cloud.management_turn(self.env)
        sleep.assert_called_once_with(15)
        with patch.object(cloud,'running_workflows') as reads:
            cloud.management_turn(dict(self.env,CLOUD_MANAGEMENT_PRIORITY='watchdog'))
        reads.assert_not_called()

    def test_catch_up_uses_ordinary_run_order_without_watchdog_priority(self):
        earlier = {'id': 100, 'path': '.github/workflows/catch-up.yml'}
        safe = [{'id': 200, 'path': '.github/workflows/catch-up.yml'},
                {'id': 300, 'path': '.github/workflows/catch-up.yml'}]
        with patch.object(cloud, 'running_workflows', side_effect=[[earlier, *safe], safe]), \
             patch.object(cloud.time, 'sleep') as sleep, contextlib.redirect_stderr(io.StringIO()):
            cloud.management_turn(self.env)
        sleep.assert_called_once_with(15)

    def test_gate_has_finite_budget_and_never_contacts_cloud_while_waiting(self):
        earlier={'id':100,'path':'.github/workflows/serverless.yml'}
        with patch.object(cloud,'environment',return_value=self.env),patch.object(cloud,'running_workflows',return_value=[earlier]),patch.object(cloud.time,'monotonic',side_effect=[0,601]),patch.object(cloud.subprocess,'run') as runner:
            with self.assertRaisesRegex(cloud.CloudRequestError,'ten minutes'):cloud.invoke('backup_create',id='synthetic')
        runner.assert_not_called()

    def test_queue_read_uses_fixed_repository_and_never_logs_error_body_or_token(self):
        env=dict(self.env,GITHUB_REPOSITORY='AngryVirus/serbia-jobs-bot',GITHUB_TOKEN='synthetic_never_real')
        with patch.object(cloud,'urlopen',side_effect=OSError('private response and credential')):
            with self.assertRaises(RuntimeError) as error:cloud.running_workflows(env)
        self.assertNotIn('private',str(error.exception));self.assertNotIn(env['GITHUB_TOKEN'],str(error.exception))
        with patch.object(cloud,'urlopen') as request:
            with self.assertRaises(RuntimeError):cloud.running_workflows(dict(env,GITHUB_REPOSITORY='untrusted/other'))
        request.assert_not_called()

    def test_pacing_survives_python_process_restarts_without_cloud_calls(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'clock';path.write_text('100')
            env={'CLOUD_REQUEST_INTERVAL':'18','CLOUD_PACE_FILE':str(path)}
            with patch.object(cloud.time,'monotonic',side_effect=[105,118]),patch.object(cloud.time,'sleep') as sleep:
                cloud.pace(env)
            sleep.assert_called_once_with(13)
            self.assertEqual(json.loads(path.read_text())['at'],118)

    def test_explicit_rate_limit_adapts_pacing_across_later_python_processes(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'clock';path.write_text(json.dumps({'at':100,'interval':2}))
            env={'CLOUD_REQUEST_INTERVAL':'2','CLOUD_PACE_FILE':str(path)}
            cloud.adapt_pacing(env,16)
            with patch.object(cloud.time,'monotonic',side_effect=[105,117]),patch.object(cloud.time,'sleep') as sleep:
                cloud.pace(env)
            sleep.assert_called_once_with(12)
            self.assertEqual(json.loads(path.read_text())['interval'],17)

    def test_backup_bridge_selects_a_complete_small_dependency_closure(self):
        script=r"""
import fs from 'node:fs';
import assert from 'node:assert/strict';
const text=fs.readFileSync('serverless/bridge.mjs','utf8');
const names=JSON.parse(text.match(/Object\.fromEntries\((\['lib\/backup'.*?\])\.map/)[1].replaceAll("'",'"'));
for(const name of names){
 const source=fs.readFileSync(`serverless/tgcloud/${name}.js`,'utf8');
 for(const match of source.matchAll(/^import .*? from ['"]([^'"]+)['"]/gm)){
  assert(match[1].startsWith('./'));
  assert(names.includes('lib/'+match[1].slice(2,-3)),`${name} dependency missing: ${match[1]}`);
 }
}
assert(!names.some(n=>n.includes('image')||n==='lib/bot'));
assert(text.includes("backupAdmin(input,ctx,{db,api})"));
process.stdout.write(JSON.stringify({modules:names.length,bytes:names.reduce((n,name)=>n+fs.statSync(`serverless/tgcloud/${name}.js`).size,0)}));
"""
        result=subprocess.run(['node','--input-type=module','-e',script],cwd=ROOT,capture_output=True,text=True)
        self.assertEqual(result.returncode,0,result.stderr)
        size=json.loads(result.stdout)
        self.assertLess(size['bytes'],100000)


if __name__=='__main__':unittest.main()
