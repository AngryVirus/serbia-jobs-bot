// Only approved reviews affect public scores. Copies share IDs; after a later
// catalogue merge, keep one (latest) vote per author rather than double-counting.
export const REVIEW_SCOPE="kind='vacancy_review' AND json_extract(payload,'$.job_id') IN (SELECT value FROM json_each(:ids))";
export const publicReviews=`SELECT record_key,payload,ROW_NUMBER() OVER (PARTITION BY json_extract(payload,'$.uid') ORDER BY json_extract(payload,'$.at') DESC,record_key DESC) AS position FROM sjc_records WHERE ${REVIEW_SCOPE} AND json_extract(payload,'$.state')='published'`;
export async function ratingSummary(store,ids,preview=false){
 const latest=preview?`,(SELECT substr(json_extract(payload,'$.text'),1,161) FROM approved WHERE position=1 ORDER BY json_extract(payload,'$.at') DESC,record_key DESC LIMIT 1) AS latest_text,
 (SELECT json_extract(payload,'$.stars') FROM approved WHERE position=1 ORDER BY json_extract(payload,'$.at') DESC,record_key DESC LIMIT 1) AS latest_stars`:'';
 return store.db.get(`WITH approved AS (${publicReviews}) SELECT COUNT(*) AS count,AVG(json_extract(payload,'$.stars')) AS average${latest} FROM approved WHERE position=1`,{':ids':JSON.stringify(ids)});
}
export function ratingLine(r){
 if(!r?.count)return '⭐ Оценок пока нет';
 const average=Number(r.average),stars='⭐'.repeat(Math.max(1,Math.min(5,Math.round(average))));
 return `${stars} ${average.toFixed(1).replace('.',',')}/5 · отзывов: ${r.count}`+(average<=2?'\n\n<b>🔴 Низкий рейтинг</b>\nПрочитайте отзывы перед откликом.':'');
}
