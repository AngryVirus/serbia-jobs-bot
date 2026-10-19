import { staffRoute,staffInput } from './staff.js';
import { accessRole,rank } from './permissions.js';
import { banInput, inboundBanNotice, deliverBanNotice, moderatorSnapshot } from './bans.js';
import { imagePanel, textPanel } from './image-panel.js';
import { activity, usage, freshness } from './analytics.js';
import { OPTIONS } from './config.js';
import { settings, defaults, choose, hidden, validUrl } from './filters.js';
import { groupJobs, visibleJobs, hiddenGroups, includesId, decorate } from './catalog.js';
import { Store, positive } from './store.js';
import { OWNER_ID, complaint } from './owner.js';
import { adRoute, adInput } from './ads.js';
import { searchRoute, searchInput, replaySearches } from './searches.js';
import { openDiscovery, discoveryRoute, replayDiscovery } from './discovery.js';
import { button, BACK, safe, menu, filtersPanel, choicePanel, emptyText, jobButtons, translatedCard, viewerButtons, browserUrl, cardActions } from './ui.js';
const DELETED_TEXT='Ваши данные удалены. Уведомления выключены. /start — начать заново.';
const discoveryAction=action=>/^(discover:|similar:|risk:|search:0$|plans:(?:open|new):)/.test(action||'');
const inputMutation=action=>typeof action==='string' && (discoveryAction(action)||/^plans(?::|$)/.test(action)||/^(notify:(off|instant|daily)|toggle_salary|reset|delete_confirm)$/.test(action) || /^(choose:|set:|hide:|restore:)/.test(action) || /^view:[^:]+:[^:]+:hide:/.test(action) || action.startsWith('input:') && Object.hasOwn(PROMPTS,action.slice(6)));
const inputScreen=action=>typeof action!=='string'?'menu':discoveryAction(action)?'discovery':/^plans(?::|$)/.test(action)?'plans':/^(choose|set):/.test(action)?'filters':action==='toggle_salary'||action==='reset'?'filters':action==='delete_confirm'?'deleted':action?.startsWith('input:')?action:'menu';
const PROMPTS = { keywords: 'Введите слова или фразы через запятую. Достаточно совпадения одного. Для распространённых профессий учитываются формы слов: «повар» найдёт «повара». «-» — очистить.', exclusions: 'Введите исключения через запятую. «-» — очистить.', salary: 'Введите минимальную зарплату в месяц: 1000 EUR или 120000 RSD. Сравниваем только выбранную валюту; почасовую и годовую оплату в месячную не пересчитываем. Объявления без суммы зависят от переключателя «Без зарплаты». «-» — снять фильтр.' };
export class Bot {
  constructor(deps) { this.api = deps.api; this.fetch = deps.fetch; this.store = new Store(deps.db); this.InputFile=deps.InputFile; }
  async panel(text, rows = BACK, mid = this.mid, visual = true) {
    if(this.InputFile) return visual ? imagePanel(this,text,rows,mid) : textPanel(this,text,rows,mid);
    const params = { chat_id: this.chat, text, parse_mode: 'HTML', reply_markup: { inline_keyboard: rows }, link_preview_options: { is_disabled: true } };
    if (mid) {
      try { await this.api.editMessageText({ ...params, message_id: mid }); return; }
      catch (error) { if (/message is not modified/i.test(error.description || error.message)) return; if (error.code !== 400) throw error; }
    }
    await this.api.sendMessage(params);
  }
  async patch(fields) { this.s = await this.store.patch(this.uid, fields); }
  async patchInput(fields,screen='menu') { this.s=await this.store.patchInput(this.uid,fields,this.updateKey,screen); }
  async replayInput(screen) {
    if(screen==='deleted')return this.panel(DELETED_TEXT,[],null);
    if(screen==='filters')return this.panel(...filtersPanel(this.s));
    if(screen==='plans')return replaySearches(this);
    if(screen==='discovery')return replayDiscovery(this);
    if(screen?.startsWith('input:') && Object.hasOwn(PROMPTS,screen.slice(6)) && this.s.pending_input===screen.slice(6))return this.panel(PROMPTS[screen.slice(6)]+'\n/cancel — отмена.',[[button('✖ Отменить ввод','cancel')],...BACK]);
    return this.home();
  }
  async showPlan(id,newOnly=false) {return openDiscovery(this,id,newOnly?'new':'all');}
  async notifications() {
    await this.panel('<b>🔔 Уведомления текущего поиска</b>\n\nНовая вакансия по текущим фильтрам придёт после обнаружения. У сохранённых поисков свои переключатели: Фильтры → Мои поиски. Проверка источников запускается примерно каждые 30 минут; запуск может задержаться. Старый каталог при включении не рассылается. Одна вакансия не приходит повторно при совпадении нескольких поисков.', [[button(this.s.notifications === 'off' ? '🔔 Включить' : '🔕 Выключить', this.s.notifications === 'off' ? 'notify:instant' : 'notify:off')], ...BACK]);
  }
  async input(text) {
    const field = this.s.pending_input; let patch;
    if (field === 'hour') { await this.patchInput({ pending_input: null }); return this.notifications(); }
    if (field === 'keywords' || field === 'exclusions') {
      const values = text.trim() === '-' ? [] : [...new Set(text.split(',').map(x => x.trim()).filter(Boolean))];
      if (values.length > 15 || values.some(x => [...x].length > 60)) return this.panel('Максимум 15 слов или фраз, до 60 символов каждое.');
      patch = { [field]: values };
    } else if (field === 'salary') {
      if (text.trim() === '-') patch = { min_salary: null };
      else {
        const m = /^\s*(\d+(?:[.,]\d{1,2})?)\s+(EUR|RSD)\s*$/.exec(text.toUpperCase());
        if (!m || Number(m[1].replace(',', '.')) > 100000000) return this.panel(PROMPTS.salary);
        patch = { min_salary: Number(m[1].replace(',', '.')), currency: m[2] };
      }
    } else return this.panel('Неизвестная настройка. Используйте /cancel.');
    await this.patchInput({ ...patch, pending_input: null },'filters');
    await this.panel(...filtersPanel(this.s));
  }
  async home() {
    const count = hidden(this.s).size ? hiddenGroups(groupJobs(await this.store.jobs()), this.s).length : 0;
    const [text,rows] = menu(this.s,count);
    const role=await accessRole(this);
    if(rank(role))rows.push([button(role==='owner'?'📊 Отчёт владельца':role==='administrator'?'🛡 Админ-панель':'🛡 Модерация','admin')]);
    return this.panel(text,rows);
  }
  async hiddenPanel(page = 0) {
    const groups = hiddenGroups(groupJobs(await this.store.jobs()), this.s), ids = groups.map(g => g.id), pages = Math.max(1, Math.ceil(ids.length / 5));
    page = Math.min(Math.max(0, page), pages - 1);
    if (!ids.length) return this.panel('<b>🙈 Скрытые вакансии</b>\n\nЗдесь пока пусто. Кнопка «Скрыть» уберёт вакансию из вашего поиска и уведомлений.', [[button('🔎 Найти вакансии', 'search:0')], ...BACK]);
    const lines = [`<b>🙈 Скрытые вакансии · ${ids.length}</b>`, 'Нажмите «Вернуть», чтобы снять скрытие.'], rows = [];
    for (let i = page*5; i < Math.min(ids.length, (page+1)*5); i++) {
      const j = groups[i].members[0];
      lines.push(`\n<b>${i+1}. ${safe(j?.title || `Вакансия №${ids[i]} (больше нет в базе)`,100)}</b>`);
      rows.push([button(`↩️ Вернуть №${i+1}`, `restore:${ids[i]}:${page}`)]);
    }
    const nav = [];
    if (page) nav.push(button('⬅️', `hidden:${page-1}`));
    if (page+1 < pages) nav.push(button('➡️', `hidden:${page+1}`));
    if (nav.length) rows.push(nav);
    lines.push(`\nСтраница ${page+1} из ${pages}`);
    await this.panel(lines.join('\n'), [...rows, ...BACK]);
  }
  async show(index = 0, jobId = null, action = 'show', mode = 's', afterId = null) {
    const all = await this.store.jobs(), groups = groupJobs(all); let notice = '';
    const eligible = () => visibleJobs(groups, this.s);
    const isAnchor = j => j._duplicate_ids.includes(jobId);
    if (action === 'hide' && all.some(j => j.id === jobId)) {
      const oldIndex = eligible().findIndex(isAnchor);
      if (oldIndex >= 0) index = oldIndex;
      await this.patchInput({ hidden_jobs: [...new Set([...hidden(this.s), jobId])].sort((a,b) => a-b) });
      notice = '<i>🙈 Вакансия скрыта</i>\n\n';
    }
    const jobs = eligible();
    notice+=await freshness(this.store);
    if(jobId===null && action==='show') {await usage(this.store,'searches');if(!jobs.length)await usage(this.store,'empty');}
    if (!jobs.length) return this.panel(notice + (all.length ? emptyText(groups, this.s) : '⏳ База ещё наполняется. Попробуйте поиск через несколько минут.'), [[button('⚙️ Фильтры', 'filters'), button('🙈 Скрытые', 'hidden:0')], ...BACK]);
    const current = jobs.findIndex(isAnchor);
    if (jobId !== null && current < 0 && ['show','details','translate'].includes(action)) { notice = '<i>Подборка изменилась — показана актуальная вакансия.</i>\n\n'; action = 'show'; mode = 's'; }
    if (current >= 0) index = current + (action === 'next' ? 1 : action === 'prev' ? -1 : 0);
    else if (action === 'prev') index--;
    if (afterId !== null) { const anchor = all.findIndex(j => j.id === afterId); if (anchor >= 0) { const before = new Set(all.slice(0, anchor+1).map(j => j.id)); index = jobs.filter(j => j._duplicate_ids.some(id => before.has(id))).length; } }
    index = Math.min(Math.max(0,index), jobs.length-1);
    if (action === 'details') mode = mode.slice(0,-1) + (mode.endsWith('f') ? 's' : 'f');
    else if (action === 'translate') mode = mode.startsWith('r') ? mode.slice(1) : 'r'+mode;
    else if (['next','prev','hide'].includes(action)) mode = 's';
    const result = await translatedCard(jobs[index], mode, this.fetch, this.store);
    await this.panel(notice + `<i>Вакансия ${index+1} из ${jobs.length}</i>\n\n` + result.text, viewerButtons(jobs[index], index, jobs.length, result.mode, result.failed),this.mid,false);
  }
  async vacancy(action) {
    const m = /^(job|hide|restore):([1-9]\d*)(?::(full|short|ru_full|ru_short|\d+))?$/.exec(action);
    if (!m || !positive(Number(m[2]))) return this.home();
    const [,kind,rawId,arg] = m, id = Number(rawId), ids = hidden(this.s);
    const group = groupJobs(await this.store.jobs()).find(g => includesId(g, id));
    if (kind === 'restore') {
      if (arg !== undefined && !/^\d+$/.test(arg)) return this.home();
      for (const member of group?.members || [{ id }]) ids.delete(member.id); await this.patchInput({ hidden_jobs: [...ids] });
      if (arg !== undefined) return this.hiddenPanel(Number(arg));
      return this.panel('<b>↩️ Вакансия возвращена</b>\nОна снова доступна при совпадении с вашими фильтрами. История уведомлений сохранена.', [[button('🔎 Найти вакансии', 'search:0'), button('🙈 Скрытые', 'hidden:0')], ...BACK]);
    }
    if (kind === 'hide' && arg !== undefined || kind === 'job' && !['full','short','ru_full','ru_short',undefined].includes(arg)) return this.home();
    const original = group?.members.find(j => j.id === id), j = original && decorate(group, original);
    if (!j) return this.panel('Вакансия больше не доступна.');
    if (group.members.some(j=>j._moderated) && this.uid !== OWNER_ID) return this.panel('Объявление снято с выдачи после проверки.',[[button('🔎 Найти вакансии','search:0')],...BACK]);
    if (kind === 'hide') { ids.add(id); await this.patchInput({ hidden_jobs: [...ids] }); }
    if (group.members.some(j => ids.has(j.id))) return this.panel('<b>🙈 Вакансия скрыта</b>\n' + safe(j.title,100), [[button('↩️ Вернуть', `restore:${id}`), button('🙈 Скрытые', 'hidden:0')], ...BACK]);
    const mode = (arg?.startsWith('ru_') ? 'r' : '') + (arg?.endsWith('full') ? 'f' : 's');
    const result = await translatedCard(j, mode, this.fetch, this.store), rows = jobButtons(j,result.mode);
    if (result.failed && validUrl(j.url)) rows.push([{ text: '🌐 Перевести в браузере', url: browserUrl(j) }]);
    await this.panel(result.text, rows, this.mid, false);
  }
  async route(action) {
    if (typeof action !== 'string') return this.home();
    const kind = /^report:.*:(not_job|duplicate|outdated)(:|$)/.test(action) ? 'report' : /translate|^job:\d+:ru_|^(view|discover):.*:(rs|rf)$/.test(action) ? 'translate' : /^(search:|view:|job:|discover:|similar:|risk:|plans:(?:open|new):)/.test(action) ? 'search' : null;
    if(kind) {
      const [limit,seconds]={search:[40,60],translate:[10,60],report:[5,60]}[kind];
      const wait=await this.store.rate(`${this.uid}:${kind}`,limit,seconds);
      if(wait) return this.panel(`Слишком много запросов. Повторите через ${wait} сек.`);
      if(kind==='translate')await usage(this.store,'translations');
    }
    if(action==='ads'||action.startsWith('ads:')) return adRoute(this,action);
    if(/^plans(?::|$)/.test(action))return searchRoute(this,action);
    if(action==='search:0')return openDiscovery(this);
    if(/^(discover:|similar:|risk:)/.test(action))return discoveryRoute(this,action);
    action = action.replace(/^(choose|set):freshness:(today|yesterday)(?=:|$)/, '$1:freshness:7');
    if (action === 'menu' || action === 'start' || action === 'cancel') return this.home();
    if (action === 'filters') return this.panel(...filtersPanel(this.s));
    if (action === 'help') return this.panel('<b>💬 Помощь</b>\n\nЕсли нужна помощь с настройками или вы нашли ошибку, напишите владельцу. Кратко опишите, что произошло.', [[{ text: '✉️ Написать владельцу', url: 'https://t.me/AngryVirus' }], ...BACK]);
    if (action === 'notifications' || action === 'input:hour') return this.notifications();
    if (/^notify:(off|instant|daily)$/.test(action)) {
      const mode = action === 'notify:off' ? 'off' : 'instant', patch = { notifications: mode };
      if (mode !== 'off' && this.s.notifications === 'off') patch.notifications_after_id = await this.store.latest();
      await this.patchInput(patch); return this.home();
    }
    let m;
    if (action === 'admin' || action.startsWith('admin:')) return staffRoute(this,action);
    if ((m = /^actions:([1-9]\d*):(-1|\d+):(s|f|rs|rf)$/.exec(action)) && positive(Number(m[1])) && Number(m[2])<=1000000) {
      const j=await this.store.job(Number(m[1]));
      return j ? this.panel(...cardActions(j,Number(m[2]),m[3])) : this.panel('Вакансия больше не найдена.');
    }
    if ((m = /^report:([1-9]\d*):(choose|not_job|duplicate|outdated):(-1|\d+):(s|f|rs|rf)(?::([a-z0-9]{8}))?$/.exec(action)) && positive(Number(m[1])) && Number(m[3])<=1000000) return complaint(this,Number(m[1]),m[2]==='choose'?null:m[2],Number(m[3]),m[4],m[5]);
    if ((m = /^report:([1-9]\d*)(?::(not_job|duplicate|outdated))?$/.exec(action)) && positive(Number(m[1]))) return complaint(this,Number(m[1]),m[2]);
    if ((m = /^search:(\d+)(?::(\d+))?$/.exec(action))) return this.show(Math.min(Number(m[1]),200000)*5,null,'show','s',m[2] ? Number(m[2]) : null);
    if ((m = /^view:([1-9]\d*):(\d+):(show|next|prev|details|translate|hide):(s|f|rs|rf)$/.exec(action)) && positive(Number(m[1])) && Number(m[2]) <= 1000000) return this.show(Number(m[2]),Number(m[1]),m[3],m[4]);
    if ((m = /^hidden:(\d+)$/.exec(action))) return this.hiddenPanel(Number(m[1]));
    if (/^(job|hide|restore):/.test(action)) return this.vacancy(action);
    if (/^(sources$|source:|favorite:|favorites:)/.test(action)) return this.home();
    if (action.startsWith('input:') && Object.hasOwn(PROMPTS,action.slice(6))) { const field = action.slice(6); await this.patchInput({ pending_input: field },`input:${field}`); return this.panel(PROMPTS[field] + '\n/cancel — отмена.', [[button('✖ Отменить ввод','cancel')], ...BACK]); }
    if (Object.hasOwn(OPTIONS,action)) return this.panel(...choicePanel(this.s,action));
    if ((m = /^(choose|set):([^:]+):([^:]+)(?::([01]))?$/.exec(action)) && OPTIONS[m[2]] && Object.hasOwn(OPTIONS[m[2]],m[3])) {
      if (m[1] === 'choose' && m[4] !== undefined) { await this.patchInput({ [m[2]]: choose(this.s,m[2],m[3],m[4] === '1') },'filters'); return this.panel(...choicePanel(this.s,m[2])); }
      if (m[1] === 'set' && m[4] === undefined) { await this.patchInput({ [m[2]]: m[3] },'filters'); return this.panel(...filtersPanel(this.s)); }
    }
    if (action === 'toggle_salary') { await this.patchInput({ include_unknown_salary: !this.s.include_unknown_salary },'filters'); return this.panel(...filtersPanel(this.s)); }
    if (action === 'reset') { const d = defaults(); await this.patchInput(Object.fromEntries(['keywords','exclusions','city','remote','language','min_salary','currency','include_unknown_salary','freshness','residence_permit'].map(k => [k,d[k]])),'filters'); return this.panel(...filtersPanel(this.s)); }
    if (action === 'delete') return this.panel('Удалить ваши настройки, скрытые вакансии, жалобы и историю уведомлений?', [[button('Удалить мои данные','delete_confirm')], ...BACK]);
    if (action === 'delete_confirm') { if(!await this.store.deleteUser(this.uid,this.updateKey))return this.home(); this.s=null; return this.panel(DELETED_TEXT, [], null); }
    return this.home();
  }
  async removeAcceptedInput(message,callback) {
    if(callback || message.chat?.type!=='private' || message.from?.id!==message.chat?.id || !positive(message.message_id))return;
    try {await this.api.deleteMessage({chat_id:message.chat.id,message_id:message.message_id});}
    catch {/* Cleanup must never replay a completed action or log the received text. */}
  }
  async finishAcceptedInput(key,message,callback) {
    await this.store.finishUpdate(key);
    await this.removeAcceptedInput(message,callback);
  }
  async handle(update) {
    const callback = update.callback_query, message = callback?.message || update.message || {}, user = callback?.from || message.from || {};
    const valid = message.chat?.type === 'private' && positive(user.id) && message.chat.id===user.id && !user.is_bot;
    if(positive(user.id) && user.id!==OWNER_ID && await inboundBanNotice(this,user.id,message.chat?.id,valid))return;
    if (callback && !valid) { try { await this.api.answerCallbackQuery({ callback_query_id: callback.id, ...(!valid ? { text: 'Откройте личный чат с ботом.' } : {}) }); } catch { /* expired acknowledgements do not cancel the action */ } }
    if (!valid) return;
    this.actor=moderatorSnapshot(user);
    this.uid = user.id; this.chat = message.chat.id; this.mid = callback ? message.message_id : null; this.isPhoto=Boolean(message.photo?.length);
    // Emergency stop must remain available while the owner's start request sends a batch.
    if(callback?.data==='ads:emergency' && this.uid===OWNER_ID && this.chat===OWNER_ID && await this.store.meta('active')) {
      try{await this.api.answerCallbackQuery({callback_query_id:callback.id});}catch{}
      const key=`emergency:${update.update_id ?? callback.id}`;
      if(!await this.store.claimUpdate(key)) return;
      try {await adRoute(this,'ads:emergency');await this.store.finishUpdate(key);}
      catch(error) {await this.store.releaseUpdate(key);throw error;}
      return;
    }
    const owner = `${Date.now()}:${Math.random()}`, lock = `user:${this.uid}`;
    if (!await this.store.lock(lock, owner, 180)) throw new Error('User operation busy; retry update');
    const key = update.update_id != null ? `u:${update.update_id}` : callback ? `c:${callback.id}` : `m:${this.chat}:${message.message_id}`;
    this.updateKey=key;
    let claimed = false;
    try {
      claimed = await this.store.claimUpdate(key);
      if (!claimed) {
        const previous=await this.store.db.get('SELECT state FROM sjc_updates WHERE key=:key',{':key':key});
        if(previous?.state==='done')await this.removeAcceptedInput(message,callback);
        return;
      }
      if(this.uid!==OWNER_ID && await this.store.isBanned(this.uid)){if(this.uid===this.chat)await deliverBanNotice(this.store,this.api,this.InputFile,this.uid,{contact:true});await this.store.finishUpdate(key);return;}
      if(callback){
        const refreshing=this.uid===OWNER_ID && this.chat===OWNER_ID && /^admin:(?:refresh|details:refresh|(?:stats|quality)(?::[a-z0-9]+)*:refresh)$/.test(callback.data||'');
        try{await this.api.answerCallbackQuery({callback_query_id:callback.id,...(refreshing?{text:'Обновляю сохранённые данные…'}:{})});}catch{}
      }
      if(!await this.store.meta('active')){await this.panel('⏳ Бот обновляется. Попробуйте через несколько минут.');await this.finishAcceptedInput(key,message,callback);return;}
      const replay=await this.store.inputEffectStatus(this.uid,key);
      if(replay && replay.status!=='planned'){
        this.s=replay.user?settings(replay.user.settings):null;
        if(replay.status==='applied')await this.replayInput(replay.effect.screen);
        await this.finishAcceptedInput(key,message,callback);return;
      }
      this.s = settings((await this.store.ensure(this.uid,this.chat)).settings);
      const ordinary=!(callback && /^(admin(?::|$)|ads(?::|$))/.test(callback.data||'')) && !(this.s.pending_input && !['keywords','exclusions','salary','hour','search_name'].includes(this.s.pending_input));
      const mutation=callback?inputMutation(callback.data):Boolean(this.s.pending_input);
      const cleanup=this.s.pending_input || this.s.ban_draft || this.s.staff_draft || this.s.search_operation;
      if(ordinary && (mutation || cleanup))await this.store.inputEffect(this.uid,key,callback?inputScreen(callback.data):this.s.pending_input && !message.text?.startsWith('/')?this.s.pending_input==='search_name'?'plans':'filters':'menu');
      if(!callback && ['keywords','exclusions','salary','hour','owner_ban','owner_ban_reason','staff_target','search_name'].includes(this.s.pending_input) && !message.text?.startsWith('/') && positive(this.s.ui_panel_id)) {this.mid=this.s.ui_panel_id;this.isPhoto=this.s.ui_panel_kind==='photo';}
      await this.store.captureUsername(this.uid,user.username);
      await activity(this.store,this.uid);
      if(this.s.bot_blocked) await this.patch({bot_blocked:false});
      let action;
      if (callback) {
        action = typeof callback.data==='string'?callback.data:'';
        const fields={...(this.s.staff_draft&&!action.startsWith('admin:team:confirm:')?{staff_draft:null}:{}),...(this.s.pending_input || this.s.ban_draft && !action.startsWith('admin:bans:confirm:')?{pending_input:null,...(!action.startsWith('admin:bans:confirm:')?{ban_draft:null,ban_target:null}:{})}:{})};
        if(this.s.search_operation && action!==`plans:${this.s.search_operation.type==='update'?'replace':'remove'}:${this.s.search_operation.id}:${this.s.search_operation.token}`)fields.search_operation=null;
        if(Object.keys(fields).length) {
          if(ordinary && !mutation)await this.patchInput(fields);else await this.patch(fields);
        }
      }
      else {
        if(await searchInput(this,message)){await this.finishAcceptedInput(key,message,callback);return;}
        if(await staffInput(this,message)){await this.finishAcceptedInput(key,message,callback);return;}
        if(await banInput(this,message)){await this.finishAcceptedInput(key,message,callback);return;}
        if(await adInput(this,message)) {await this.finishAcceptedInput(key,message,callback);return;}
        const text = message.text;
        if (typeof text !== 'string' || !text.trim()) { await this.finishAcceptedInput(key,message,callback); return; }
        if ([...text].length > 1000) { await this.panel('Пожалуйста, сократите сообщение до 1000 символов.'); await this.finishAcceptedInput(key,message,callback); return; }
        if (this.s.pending_input && !text.startsWith('/')) { await this.input(text); await this.finishAcceptedInput(key,message,callback); return; }
        if (this.s.pending_input || this.s.ban_draft || this.s.staff_draft || this.s.search_operation) {const fields={pending_input:null,ban_draft:null,ban_target:null,staff_draft:null,search_operation:null};if(ordinary)await this.patchInput(fields);else await this.patch(fields);}
        action = ({ '/start': 'start', '/menu': 'menu', '/cancel': 'menu', '/delete_me': 'delete', '/admin': 'admin' })[text.split(/\s+/)[0].split('@')[0]] || 'menu';
      }
      await this.route(action);
      await this.finishAcceptedInput(key,message,callback);
    } catch (error) { if (claimed) await this.store.releaseUpdate(key); throw error; }
    finally { await this.store.unlock(lock,owner); }
  }
}
