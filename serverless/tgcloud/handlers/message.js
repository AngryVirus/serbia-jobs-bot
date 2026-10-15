import { db, api, fetch } from 'sdk';
import { Bot } from '../lib/bot.js';
export default async function(message, ctx) {
  return new Bot({ db, api, fetch }).handle(ctx?.update || { message });
}
