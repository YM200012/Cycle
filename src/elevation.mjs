const invalid=message=>Object.assign(Error(message),{status:400});
export const ELEVATION_SOURCE='Terrarium DEM';
export function normalizeElevation(input,streams){
 if(!input||input.source!==ELEVATION_SOURCE||input.zoom!==12||typeof input.createdAt!=='string'||!Number.isFinite(Date.parse(input.createdAt))||!Array.isArray(input.points)||!input.points.length||input.points.length>150000)throw invalid('地形高程校正格式无效');
 const rows=new Map(streams.map(r=>[r.time,r]));let last=-1;
 const points=input.points.map(p=>{const r=rows.get(p?.time);if(!r||p.time<=last||!Number.isFinite(p.altitude)||p.altitude< -500||p.altitude>10000||!Number.isFinite(r.lat)||!Number.isFinite(r.lon)||r.lat!==p.lat||r.lon!==p.lon)throw invalid('高程校正必须对应原始 GPS 采样且按时间排序');last=p.time;return {time:p.time,lat:p.lat,lon:p.lon,altitude:p.altitude};});
 return {source:ELEVATION_SOURCE,zoom:12,createdAt:input.createdAt,points};
}
/** Original streams and device summaries remain unchanged in storage. */
export function elevationActivity(activity={}){
 if(!activity.elevationCorrection)return activity;
 const corrected=new Map(activity.elevationCorrection.points.map(p=>[p.time,p]));
 const streams=(activity.streams||[]).map(r=>{const p=corrected.get(r.time),out={...r};delete out.altitude;delete out.grade;if(p&&r.lat===p.lat&&r.lon===p.lon)out.altitude=p.altitude;return out;});
 const fitSummary={...activity.fitSummary};for(const key of ['ascent','descent','minAltitude','maxAltitude'])delete fitSummary[key];
 return {...activity,streams,fitSummary};
}
