// Public vacancy text only. Cache is shared by readers, never by private messages.
export function sourceLanguage(text) {
  const words=String(text).toLowerCase().match(/[\p{L}]+/gu)||[];
  const vocabulary={
    ru:new Set('и в на для требуется работа опыт мы вы обязанности условия зарплата сотрудник нужен'.split(' ')),
    sr:new Set('i u na za posao rad radno iskustvo potrebna potreban potrebno uslovi odgovornosti nudimo zaposlenje sa je se iz ili koji rada и у за посао рад искуство потребан потребна услови'.split(' ')),
    en:new Set('the and for with you we our experience required responsibilities job work skills are is to of a in your'.split(' ')),
  };
  const scores=Object.entries(vocabulary).map(([lang,set])=>[lang,words.filter(w=>set.has(w)).length]).sort((a,b)=>b[1]-a[1]);
  return scores[0][1]>=2 && scores[0][1]>scores[1][1] ? scores[0][0] : null;
}
export function chunks(text, bytes=480) {
  const result=[]; let current='',size=0;
  for(const char of text) {
    const n=encodeURIComponent(char).replace(/%[0-9A-F]{2}/g,'x').length;
    if(size+n>bytes) {
      const boundary=Math.max(current.lastIndexOf(' '),current.lastIndexOf('\n'));
      if(boundary>current.length/2) {
        result.push(current.slice(0,boundary+1)); current=current.slice(boundary+1);
        size=encodeURIComponent(current).replace(/%[0-9A-F]{2}/g,'x').length;
      } else { result.push(current); current=''; size=0; }
    }
    current+=char; size+=n;
  }
  if(current) result.push(current);
  return result;
}
export async function translateVacancy(id, title, description, fetch, store) {
  const key=`ru:${id}`, original=[title,description];
  const saved=await store?.meta(`translation:${key}`);
  if(saved && saved.original?.every((x,i)=>x===original[i]) && saved.original.length===2 && Date.now()-saved.created_at<30*86400000) return saved.translated;
  const owner=`${Date.now()}:${Math.random()}`;
  if(store && !await store.lock(`translation:${key}`,owner,90)) throw new Error('Translation in progress');
  try {
    const language=sourceLanguage(description+' '+title);
    const google=async text=>{
      if((await store?.meta('translation_google_cooldown'))>Date.now()) throw new Error('Translation cooldown');
      let result='';
      for(const chunk of chunks(text,1600)) {
        const response=await fetch('https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=ru&dt=t&q='+encodeURIComponent(chunk));
        if(!response.ok) {
          if(response.status===429) await store?.setMeta('translation_google_cooldown',Date.now()+3600000);
          throw new Error('Translation unavailable');
        }
        const data=await response.json();
        if(!Array.isArray(data?.[0]) || !data[0].length) throw new Error('Invalid translation');
        for(const part of data[0]) { if(typeof part?.[0]!=='string') throw new Error('Invalid translation'); result+=part[0]; }
      }
      return result;
    };
    const fallback=async text=>{
      if(language==='ru') return text;
      if(!language || (await store?.meta('translation_fallback_cooldown'))>Date.now()) throw new Error('Translation unavailable');
      let result='';
      for(const chunk of chunks(text)) {
        const response=await fetch('https://api.mymemory.translated.net/get?langpair='+language+'%7Cru&q='+encodeURIComponent(chunk));
        if(!response.ok) {
          if(response.status===429) await store?.setMeta('translation_fallback_cooldown',Date.now()+3600000);
          throw new Error('Translation unavailable');
        }
        const data=await response.json();
        if(data.quotaFinished || Number(data.responseStatus)===429) {
          await store?.setMeta('translation_fallback_cooldown',Date.now()+86400000);
          throw new Error('Translation quota');
        }
        if(Number(data.responseStatus)!==200 || typeof data.responseData?.translatedText!=='string' || !data.responseData.translatedText.trim()) throw new Error('Invalid translation');
        result+=data.responseData.translatedText+(/\s$/.test(chunk)?' ':'');
      }
      return result.trim();
    };
    const translated=[];
    for(const text of original) {
      if(!text) { translated.push(''); continue; }
      try { translated.push(await google(text)); }
      catch { translated.push(await fallback(text)); }
    }
    await store?.setMeta(`translation:${key}`,{original,translated,created_at:Date.now()});
    return translated;
  } finally { await store?.unlock(`translation:${key}`,owner); }
}
