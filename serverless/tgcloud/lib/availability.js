// A missing source response is uncertainty, never evidence that hiring ended.
export const AVAILABILITY_AGE=30*86400000;
export function availabilityExpiry(job){
 const state=job._availability;
 return state?.state!=='closed'&&Number.isFinite(state?.verified_at)&&Object.hasOwn(state,'expires_ms')?state.expires_ms:job._cloud?.expires_ms;
}
export function availabilityAnchor(job){
 const verified=job._availability?.verified_at;
 if(Number.isFinite(verified))return verified;
 if(Number.isFinite(job._cloud?.published_ms))return job._cloud.published_ms;
 for(const value of [job.published_at,job.created_at,job._availability_baseline]){
  const stamp=Date.parse(value);if(Number.isFinite(stamp))return stamp;
 }
 return null;
}
export function availabilityAllows(job,now=Date.now()){
 if(job._availability?.state==='closed')return false;
 const expiry=availabilityExpiry(job);
 if(Number.isFinite(expiry))return expiry>now;
 const anchor=availabilityAnchor(job);
 return anchor===null||now-anchor<AVAILABILITY_AGE;
}
