import { db, api, fetch, InputFile } from 'sdk';
import { Bot } from '../lib/bot.js';
export default async function(message, ctx) {
  return new Bot({ db, api, fetch, InputFile }).handle(ctx?.update || { message });
}
