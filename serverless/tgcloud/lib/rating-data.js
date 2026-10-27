// Only approved reviews affect public scores. Copies share IDs; after a later
// catalogue merge, keep one (latest) vote per author rather than double-counting.
export const REVIEW_SCOPE="kind='vacancy_review' AND json_extract(payload,'$.job_id') IN (SELECT value FROM json_each(:ids))";
export const publicReviews=`SELECT record_key,payload,ROW_NUMBER() OVER (PARTITION BY json_extract(payload,'$.uid') ORDER BY json_extract(payload,'$.at') DESC,record_key DESC) AS position FROM sjc_records WHERE ${REVIEW_SCOPE} AND json_extract(payload,'$.state')='published'`;
export async function ratingSummary(store,ids){
 return store.db.get(`SELECT COUNT(*) AS count,AVG(json_extract(payload,'$.stars')) AS average FROM (${publicReviews}) WHERE position=1`,{':ids':JSON.stringify(ids)});
}
export function ratingLine(r){
 if(!r?.count)return '⭐ Оценок пока нет';
 const average=Number(r.average),stars='⭐'.repeat(Math.max(1,Math.min(5,Math.round(average))));
 return `${stars} ${average.toFixed(1).replace('.',',')}/5 · отзывов: ${r.count}`+(average<=2?'\n<b>⚠️ Низкий рейтинг. Прочитайте отзывы перед откликом.</b>':'');
}
