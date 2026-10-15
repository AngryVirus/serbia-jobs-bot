import { db, api } from 'sdk';
import { runProbe } from '../lib/probe.js';

// Executed only with the owner-authenticated CLI's `run`; never published.
export default async function (input, ctx) {
  const result = await runProbe(input, ctx, { db, api });
  console.log('SJ_PROBE_RESULT:' + JSON.stringify(result));
  return result;
}
