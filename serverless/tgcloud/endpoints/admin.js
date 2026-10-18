import { db, api, fetch, InputFile } from 'sdk';
import { administer } from '../lib/admin.js';
export default async function(input, ctx) {
  const result = await administer(input,ctx,{ db, api, fetch, InputFile });
  return result;
}
