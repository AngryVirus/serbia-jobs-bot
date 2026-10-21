"""Collection worker uses durable bounded notifications and forwards expiry edits."""
import contextlib
import io
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'serverless'))
import collect
from cloud import CloudRequestError
from sources import Job


class CollectionWorkerTests(unittest.TestCase):
    def test_saved_link_maintenance_does_not_consume_the_discovery_budget(self):
        clock=[0]
        def recheck(owner,deadline):
            self.assertEqual(deadline,180)
            clock[0]=180
            return {'checked':12,'closed':0,'verified':1}
        def collect_all(**fields):
            clock[0]=1300  # Beyond the old shared budget, within 180 + 1200.
            fields['on_source']('radim',[],{'state':'ok'})
        def invoke(operation,**fields):
            if operation=='init':return {'active':True}
            if operation=='collection_end':return {'released':True}
            if operation=='collect':return {'added':0}
            return {}
        with patch.object(collect,'invoke',side_effect=invoke) as calls, \
             patch.object(collect.time,'monotonic',side_effect=lambda:clock[0]), \
             patch.object(collect,'recheck',side_effect=recheck), \
             patch.object(collect,'collect_all',side_effect=collect_all), \
             patch.object(collect,'notify',return_value=(0,0)),contextlib.redirect_stdout(io.StringIO()):collect.main()
        completed=next(call for call in calls.call_args_list if call.args==('collection_end',))
        self.assertFalse(completed.kwargs['failed'])

    def test_saved_link_queue_commits_only_the_inspected_batch_and_stops_at_wrap(self):
        batch={'after':0,'cursor':0,'started_at':123,'candidates':[{'id':1,'key':'radim.rs/jobs/test'}]}
        with patch.object(collect,'invoke',side_effect=[batch,{'closed':1,'verified':0}]) as invoke, \
             patch.object(collect,'inspect_batch',return_value=[{'id':1,'key':'radim.rs/jobs/test','state':'closed','reason':'gone'}]), \
             patch.object(collect.time,'monotonic',return_value=1):
            self.assertEqual(collect.recheck('owner',10),{'checked':1,'closed':1,'verified':0})
        self.assertEqual(invoke.call_args.kwargs['after'],0)
        self.assertEqual(invoke.call_args.kwargs['results'][0]['id'],1)

    def test_saved_link_probe_failure_does_not_abort_discovery_or_leak_exception_details(self):
        def invoke(operation, **fields):
            if operation=='init':return {'active':True}
            if operation=='collection_end':return {'released':True}
            if operation=='collect':return {'added':0}
            return {}
        output=io.StringIO()
        with patch.object(collect,'invoke',side_effect=invoke) as calls, \
             patch.object(collect,'recheck',side_effect=RuntimeError('private transport detail')), \
             patch.object(collect,'notify',return_value=(0,0)), \
             patch.object(collect,'collect_all',side_effect=lambda **fields:fields['on_source']('radim',[],{'state':'ok'})), \
             contextlib.redirect_stdout(output):collect.main()
        completed=next(call for call in calls.call_args_list if call.args==('collection_end',))
        self.assertFalse(completed.kwargs['failed'])
        self.assertEqual(completed.kwargs['totals']['availability_deferred'],1)
        self.assertNotIn('private transport detail',output.getvalue())

    def test_deadline_and_worker_restart_continue_the_cloud_cursor(self):
        clock, cursor, visits = [0.0], [0], []

        def invoke(operation, **fields):
            self.assertEqual((operation, fields), ('notify_batch', {'limit': 10}))
            last = min(70, cursor[0] + fields['limit'])
            visits.extend(range(cursor[0] + 1, last + 1))
            sent = last - cursor[0]
            cursor[0] = last
            return {'sent': sent, 'uncertain': 2, 'done': last == 70}

        with patch.object(collect, 'invoke', side_effect=invoke), \
             patch.object(collect.time, 'monotonic', side_effect=lambda: clock[0]), \
             patch.object(collect.time, 'sleep', side_effect=lambda delta: clock.__setitem__(0, clock[0] + delta)):
            self.assertEqual(collect.notify(clock[0] + 3), (30, 6))
            self.assertEqual(visits, list(range(1, 31)))
            self.assertEqual(collect.notify(clock[0] + 3), (30, 6))
            self.assertEqual(visits, list(range(1, 61)))
            self.assertEqual(collect.notify(clock[0] + 3), (10, 2))
        self.assertEqual(visits, list(range(1, 71)))

    def test_retry_after_busy_or_completed_round_stops_without_replaying_a_batch(self):
        for response in ({'retry_after': 30}, {'busy': True}, {'done': True}):
            with self.subTest(response=response), \
                 patch.object(collect, 'invoke', return_value={'sent': 1, 'uncertain': 2, **response}) as invoke, \
                 patch.object(collect.time, 'monotonic', return_value=1), \
                 patch.object(collect.time, 'sleep') as sleep:
                self.assertEqual(collect.notify(10), (1, 2))
                invoke.assert_called_once_with('notify_batch', limit=10)
                sleep.assert_not_called()

    def test_expired_budget_does_not_start_a_cloud_batch(self):
        with patch.object(collect.time, 'monotonic', return_value=10), patch.object(collect, 'invoke') as invoke:
            self.assertEqual(collect.notify(10), (0, 0))
            invoke.assert_not_called()

    def test_collection_opt_in_uploads_expiry_correction_as_enriched_facts(self):
        job = Job('radim', 'https://radim.rs/jobs/known', 'Support', expires_at='2020-01-01')

        def collect_all(*, on_source, include_expired, crawl_states, detail_limit, page_limit):
            self.assertTrue(include_expired)
            self.assertTrue(all(isinstance(state, dict) for state in crawl_states.values()))
            self.assertEqual((detail_limit, page_limit), (24, 4))
            on_source('radim', [job], {'state': 'ok'})

        def invoke(operation, **fields):
            if operation == 'init':
                return {'active': True}
            if operation == 'collect':
                if fields['jobs']:
                    self.assertEqual(fields['jobs'][0]['expires_at'], '2020-01-01')
                    self.assertLess(fields['jobs'][0]['_cloud']['expires_ms'], 1600000000000)
                return {'added': 0}
            if operation == 'collection_end': return {'released': True}
            return {}

        with patch.object(collect, 'collect_all', side_effect=collect_all), \
             patch.object(collect, 'invoke', side_effect=invoke) as calls, \
             patch.object(collect, 'notify', return_value=(0, 0)), \
             contextlib.redirect_stdout(io.StringIO()):
            collect.main()
        completed = next(call for call in calls.call_args_list if call.args == ('collection_end',))
        self.assertFalse(completed.kwargs['failed'])
        self.assertEqual(calls.call_args.args, ('health_tick',))

    def test_source_checkpoint_is_uploaded_only_with_the_last_confirmed_batch(self):
        jobs = [Job('radim', f'https://radim.rs/jobs/{i}', 'Support') for i in range(30)]
        checkpoint = {'version': 1, 'pending': [], 'seen': {}}
        status = {'state': 'partial', 'healthy': True, 'crawl_state': checkpoint, 'discovered': 30, 'inspected': 30,
                  'parsed_count': 30, 'rejected': {'foreign': 2}, 'truncated': True, 'backlog': 4}
        batches, states = [], []

        def invoke(operation, **fields):
            if operation == 'init': return {'active': True}
            if operation == 'collection_state':
                states.append(fields['source'])
                return {'state': {'version': 1}}
            if operation == 'collect':
                batches.append(fields)
                return {'added': len(fields['jobs'])}
            if operation == 'collection_end': return {'released': True}
            return {}

        def collect_all(**fields):
            self.assertEqual(set(fields['crawl_states']), set(states))
            fields['on_source']('radim', jobs, status)

        with patch.object(collect, 'invoke', side_effect=invoke) as calls, \
             patch.object(collect, 'collect_all', side_effect=collect_all), \
             patch.object(collect, 'notify', return_value=(0, 0)), contextlib.redirect_stdout(io.StringIO()):
            collect.main()
        self.assertEqual([len(batch['jobs']) for batch in batches], [25, 5, 0])
        self.assertNotIn('status', batches[0])
        self.assertNotIn('status', batches[1])
        self.assertEqual(batches[2]['status'], status)
        totals = next(call.kwargs['totals'] for call in calls.call_args_list if call.args == ('collection_end',))
        self.assertEqual(totals['healthy_sources'], 1)
        self.assertEqual((totals['added'], totals['inspected'], totals['rejected'], totals['truncated_sources']), (30, 30, 2, 1))

    def test_failed_upload_never_commits_a_source_checkpoint(self):
        jobs = [Job('radim', f'https://radim.rs/jobs/{i}', 'Support') for i in range(51)]
        writes = []

        def invoke(operation, **fields):
            if operation == 'init': return {'active': True}
            if operation == 'collection_state': return {'state': {}}
            if operation == 'collect':
                writes.append(fields)
                if len(writes) == 2: raise RuntimeError('Synthetic upload failure')
                return {'added': len(fields['jobs'])}
            if operation == 'collection_end': return {'released': True}
            return {}

        with patch.object(collect, 'invoke', side_effect=invoke) as calls, \
             patch.object(collect, 'collect_all', side_effect=lambda **fields: fields['on_source']('radim', jobs, {'state': 'ok', 'crawl_state': {'version': 1}})), \
             patch.object(collect, 'notify', return_value=(0, 0)), contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaisesRegex(RuntimeError, 'Synthetic upload failure'): collect.main()
        self.assertTrue(all('status' not in fields for fields in writes))
        self.assertTrue(calls.call_args.kwargs['failed'])
        self.assertEqual(calls.call_args.kwargs['totals']['added'], 25)

    def test_recovery_check_follows_only_confirmed_healthy_completion(self):
        for status, healthy in (({'state': 'ok'}, True), ({'state': 'empty'}, True),
                                ({'state': 'partial', 'healthy': True}, True),
                                ({'state': 'error'}, False),
                                ({'state': 'partial', 'healthy': False}, False)):
            with self.subTest(status=status):
                operations, completed = [], []

                def invoke(operation, **fields):
                    operations.append(operation)
                    if operation == 'init': return {'active': True}
                    if operation == 'collect': return {'added': 0}
                    if operation == 'collection_end':
                        completed.append(fields)
                        return {'released': True}
                    if operation == 'health_tick':
                        self.assertEqual(len(completed), 1)
                        self.assertFalse(completed[0]['failed'])
                        self.assertEqual(completed[0]['totals']['healthy_sources'], 1)
                    return {}

                with patch.object(collect, 'invoke', side_effect=invoke), \
                     patch.object(collect, 'collect_all', side_effect=lambda **fields: fields['on_source']('radim', [], status)), \
                     patch.object(collect, 'notify', return_value=(0, 0)), contextlib.redirect_stdout(io.StringIO()):
                    collect.main()
                self.assertEqual(operations.count('health_tick'), int(healthy))
                self.assertEqual(operations[-2:] if healthy else operations[-1:],
                                 ['collection_end', 'health_tick'] if healthy else ['collection_end'])

    def test_failed_or_unconfirmed_completion_never_requests_recovery(self):
        for failure in ('collection', 'finalization', 'unconfirmed'):
            with self.subTest(failure=failure):
                completed = []

                def invoke(operation, **fields):
                    if operation == 'init': return {'active': True}
                    if operation == 'collect': return {'added': 0}
                    if operation == 'collection_end':
                        completed.append(fields)
                        if failure == 'finalization': raise RuntimeError('Synthetic finalization failure')
                        return {} if failure == 'unconfirmed' else {'released': True}
                    if operation == 'health_tick': self.fail('Recovery before a confirmed healthy completion')
                    return {}

                def collect_all(**fields):
                    fields['on_source']('radim', [], {'state': 'ok'})
                    if failure == 'collection': raise RuntimeError('Synthetic collection failure')

                expected = {'collection': 'Synthetic collection failure', 'finalization': 'Synthetic finalization failure',
                            'unconfirmed': 'Collection completion not confirmed'}[failure]
                output = io.StringIO()
                with patch.object(collect, 'invoke', side_effect=invoke), \
                     patch.object(collect, 'collect_all', side_effect=collect_all), \
                     patch.object(collect, 'notify', return_value=(0, 0)), contextlib.redirect_stdout(output):
                    with self.assertRaisesRegex(RuntimeError, expected): collect.main()
                self.assertEqual(len(completed), 1)
                self.assertEqual(completed[0]['failed'], failure == 'collection')
                self.assertNotIn('Collection complete:', output.getvalue())

    def test_health_request_failure_preserves_confirmed_collection_and_hides_details(self):
        errors = (CloudRequestError('private gateway detail', transient=True),
                  ValueError('private response detail'), OSError('private transport detail'))
        for error in errors:
            with self.subTest(error=type(error).__name__):
                completed = []

                def invoke(operation, **fields):
                    if operation == 'init': return {'active': True}
                    if operation == 'collect': return {'added': 0}
                    if operation == 'collection_end':
                        completed.append(fields)
                        return {'released': True}
                    if operation == 'health_tick': raise error
                    return {}

                output, warnings = io.StringIO(), io.StringIO()
                with patch.object(collect, 'invoke', side_effect=invoke) as calls, \
                     patch.object(collect, 'collect_all', side_effect=lambda **fields: fields['on_source']('radim', [], {'state': 'ok'})), \
                     patch.object(collect, 'notify', return_value=(0, 0)), \
                     contextlib.redirect_stdout(output), contextlib.redirect_stderr(warnings):
                    collect.main()
                self.assertEqual(len(completed), 1)
                self.assertFalse(completed[0]['failed'])
                self.assertEqual(completed[0]['totals']['healthy_sources'], 1)
                self.assertEqual(calls.call_args.args, ('health_tick',))
                self.assertIn('Collection complete:', output.getvalue())
                self.assertIn('Independent watchdog will retry.', warnings.getvalue())
                self.assertNotIn('private', output.getvalue() + warnings.getvalue())

    def test_upload_bytes_are_bounded_for_full_multilingual_descriptions(self):
        jobs = [{'description': 'я' * 16000, 'id': i} for i in range(12)]
        batches = list(collect.upload_batches(jobs))
        self.assertGreater(len(batches), 1)
        import json
        for batch in batches:
            self.assertLessEqual(len(json.dumps(batch, ensure_ascii=False, separators=(',', ':')).encode()), collect.MAX_BATCH_BYTES)
        self.assertEqual(sum(map(len, batches)), 12)
        with self.assertRaisesRegex(RuntimeError, 'safe collection batch size'):
            list(collect.upload_batches([{'description': 'x' * collect.MAX_BATCH_BYTES}]))


if __name__ == '__main__':
    unittest.main()
