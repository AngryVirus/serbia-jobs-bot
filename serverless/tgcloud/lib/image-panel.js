import { IMAGE_VERSION, imageHash, renderImage } from './image-renderer.js';
const positive=n=>Number.isSafeInteger(n)&&n>0;
const unchanged=e=>/message is not modified/i.test(e.description || e.message || '');
async function remember(bot,id,kind) {
 if(positive(id)){bot.mid=id;bot.isPhoto=kind==='photo';if(bot.s)await bot.patch({ui_panel_id:id,ui_panel_kind:kind});}
}
async function removeOld(bot,id) {
 if(!positive(id))return;
 try {await bot.api.deleteMessage({chat_id:bot.chat,message_id:id});}
 catch { // Keep the old message inert if Telegram cannot remove it (age/permissions).
  try {await bot.api.editMessageReplyMarkup({chat_id:bot.chat,message_id:id,reply_markup:{inline_keyboard:[]}});}catch {/* no delivery or queue side effects */}
 }
}
export async function imagePanel(bot,text,rows,mid) {
 const key=bot.uid+':'+imageHash(IMAGE_VERSION+'\n'+text),now=Date.now();
 const old=bot.s && await bot.store.db.get("SELECT payload FROM sjc_records WHERE kind='menu_image' AND record_key=:key",{':key':key});
 const cached=old&&JSON.parse(old.payload);
 let photo=cached?.expires>now?cached.file_id:null,wasCached=Boolean(photo),message;
 const make=()=>{const image=renderImage(text);return new bot.InputFile(image.bytes,'menu.png',{type:'image/png'});};
 if(!photo)photo=make();
 const keyboard={inline_keyboard:rows};
 const deliver=async()=>{
  if(mid) {
   try {return await bot.api.editMessageMedia({chat_id:bot.chat,message_id:mid,media:{type:'photo',media:photo,caption:''},reply_markup:keyboard});}
   catch(error){if(unchanged(error))return {message_id:mid};if(error.code!==400)throw error;
    // A cached Telegram file can expire. Retry with local bytes exactly once.
    if(wasCached && /file|identifier|media.*invalid/i.test(error.description || error.message || '')){photo=make();wasCached=false;return deliver();}
    if(!/can't be edited|cannot be edited|message to edit not found|no media|no photo|not a media|type of message|media.*not supported/i.test(error.description || error.message || ''))throw error;
   }
  }
  try {return await bot.api.sendPhoto({chat_id:bot.chat,photo,reply_markup:keyboard});}
  catch(error){if(wasCached&&error.code===400&&/file|identifier/i.test(error.description || error.message || '')){photo=make();wasCached=false;return deliver();}throw error;}
 };
 message=await deliver();
 if(!positive(message?.message_id))throw Error('Unconfirmed image panel');
 const file=message.photo?.at(-1)?.file_id || (wasCached?photo:null);
 if(bot.s && typeof file==='string') {
  await bot.store.record('menu_image',key,{file_id:file,expires:now+7*86400000,created_at:now});
  // Bound both lifetime and count. Never store the rendered text or a plaintext image.
  await bot.store.db.run("DELETE FROM sjc_records WHERE kind='menu_image' AND record_key LIKE :prefix AND (json_extract(payload,'$.expires')<=:now OR record_key NOT IN (SELECT record_key FROM sjc_records WHERE kind='menu_image' AND record_key LIKE :prefix ORDER BY json_extract(payload,'$.created_at') DESC,record_key DESC LIMIT 30))",{':prefix':bot.uid+':%',':now':now});
 }
 await remember(bot,message.message_id,'photo');
 for(const old of new Set([mid,bot.previousPanelId]))if(old!==message.message_id)await removeOld(bot,old);
}
export async function textPanel(bot,text,rows,mid) {
 const params={chat_id:bot.chat,text,parse_mode:'HTML',reply_markup:{inline_keyboard:rows},link_preview_options:{is_disabled:true}};
 if(mid && !bot.isPhoto){
  try {await bot.api.editMessageText({...params,message_id:mid});await remember(bot,mid,'text');return;}
  catch(error){if(unchanged(error))return;if(error.code!==400)throw error;}
 }
 const message=await bot.api.sendMessage(params);
 if(!positive(message?.message_id))throw Error('Unconfirmed text panel');
 await remember(bot,message.message_id,'text');
 for(const old of new Set([mid,bot.previousPanelId]))if(old!==message.message_id)await removeOld(bot,old);
}
