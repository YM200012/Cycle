export const WEATHER_FIELDS={temperature_2m:[-100,70],apparent_temperature:[-120,90],relative_humidity_2m:[0,100],wind_speed_10m:[0,150],wind_direction_10m:[0,360],wind_gusts_10m:[0,200],cloud_cover:[0,100],rain:[0,1000],snowfall:[0,1000],weather_code:[0,100]};
export const validGps=r=>Number.isFinite(r?.lat)&&Number.isFinite(r?.lon)&&Math.abs(r.lat)<=85&&Math.abs(r.lon)<=180;
export const activityStart=a=>a.startedAt||a.fitSummary?.startedAt;
export const angle=x=>(x%360+360)%360;
export function weatherEligibility(a){
 if(a.planned)return '计划活动没有实际沿程天气。';
 if(a.indoor===true||(a.indoor!==false&&a.notes?.startsWith('FIT 经 Garmin 官方 SDK')&&a.notes.includes('虚拟骑行：路线、速度与海拔为训练平台记录')))return '室内 / 虚拟骑行不查询户外天气。';
 if(!Number.isFinite(Date.parse(activityStart(a))))return '缺少准确开始时间，请重新导入含时间戳的 FIT、GPX 或 TCX 文件。';
 if(!(a.streams||[]).filter(validGps).length||!a.streams.some((r,i,rs)=>i&&validGps(r)&&validGps(rs[i-1])&&r.time>rs[i-1].time))return '没有足够的 GPS 路线采样。';
 if(Date.parse(activityStart(a))<Date.parse('2021-01-01'))return '历史预报天气仅支持 2021 年起的活动。';
 if(Date.parse(activityStart(a))+Math.max(0,a.streams?.at(-1)?.time||0)*1000>Date.now())return '活动尚未结束，请在实际骑行结束后获取天气。';
 return '';
}
export function normalizeWeather(w,a){
 const fail=()=>{throw Object.assign(Error('沿程天气数据无效或与当前路线不匹配，请重新获取'),{status:400});};
 if(!w||w.source!=='Open-Meteo'||w.startedAt!==activityStart(a)||!Number.isFinite(Date.parse(w.retrievedAt))||!Array.isArray(w.samples)||w.samples.length>1000||!w.samples.length)fail();
 const route=new Map((a.streams||[]).map(r=>[r.time,r]));let last=-1;
 const samples=w.samples.map(s=>{const r=route.get(s?.time);if(!r||!validGps(s)||s.lat!==r.lat||s.lon!==r.lon||s.time<=last)fail();last=s.time;const out={time:s.time,lat:s.lat,lon:s.lon};for(const [k,[lo,hi]]of Object.entries(WEATHER_FIELDS)){if(s[k]===null||s[k]===undefined)continue;if(!Number.isFinite(s[k])||s[k]<lo||s[k]>hi)fail();out[k]=s[k];}return out;});
 return {source:'Open-Meteo',startedAt:w.startedAt,retrievedAt:new Date(w.retrievedAt).toISOString(),model:w.model==='historical-forecast'?'historical-forecast':'forecast',samples};
}
/** Interpolate meteorological wind vectors, including the 359°/1° seam. */
export function interpolateWeather(a,b,f){
 const out={};for(const k of Object.keys(WEATHER_FIELDS))if(k!=='wind_direction_10m'&&Number.isFinite(a[k])&&Number.isFinite(b[k]))out[k]=a[k]+(b[k]-a[k])*f;
 if(Number.isFinite(a.wind_direction_10m)&&Number.isFinite(b.wind_direction_10m)&&Number.isFinite(a.wind_speed_10m)&&Number.isFinite(b.wind_speed_10m)){
 const rad=Math.PI/180,x=Math.sin(a.wind_direction_10m*rad)*a.wind_speed_10m*(1-f)+Math.sin(b.wind_direction_10m*rad)*b.wind_speed_10m*f,y=Math.cos(a.wind_direction_10m*rad)*a.wind_speed_10m*(1-f)+Math.cos(b.wind_direction_10m*rad)*b.wind_speed_10m*f;out.wind_speed_10m=Math.hypot(x,y);if(out.wind_speed_10m>1e-6)out.wind_direction_10m=angle(Math.atan2(x,y)/rad);
 }return out;
}
export function weatherAt(samples,time,maxGap=600){
 if(!samples?.length||time<samples[0].time||time>samples.at(-1).time)return null;
 let lo=0,hi=samples.length-1;while(lo<hi){const mid=(lo+hi)>>1;if(samples[mid].time<time)lo=mid+1;else hi=mid;}
 const b=samples[lo];if(b.time===time)return b;const a=samples[lo-1];return a&&b.time-a.time<=maxGap?interpolateWeather(a,b,(time-a.time)/(b.time-a.time)):null;
}
export function routeMotion(a,b){
 if(!validGps(a)||!validGps(b)||a.timerActive===false||b.time-a.time>30||b.time<=a.time)return null;
 const rad=Math.PI/180,p=a.lat*rad,q=b.lat*rad,d=(b.lon-a.lon)*rad,dl=(b.lat-a.lat)*rad,h=Math.sin(dl/2)**2+Math.cos(p)*Math.cos(q)*Math.sin(d/2)**2,dist=12742000*Math.asin(Math.sqrt(Math.min(1,h))),speed=Number.isFinite(a.speed)?a.speed:dist/(b.time-a.time);
 if(speed<=.5||dist<.2)return null;
 return {speed,bearing:angle(Math.atan2(Math.sin(d)*Math.cos(q),Math.cos(p)*Math.sin(q)-Math.sin(p)*Math.cos(q)*Math.cos(d))/rad)};
}
export function weatherRows(a){
 const samples=a.weather?.samples||[],rows=a.streams||[];return rows.map((r,i)=>{
 const w=weatherAt(samples,r.time),m=rows[i+1]?routeMotion(r,rows[i+1]):null;if(!w)return {...r};const out={...r,wxTemperature:w.temperature_2m,wxFeels:w.apparent_temperature,wxWind:w.wind_speed_10m,wxGust:w.wind_gusts_10m,wxDirection:w.wind_direction_10m};
 if(m&&Number.isFinite(w.wind_direction_10m)&&Number.isFinite(w.wind_speed_10m)){const rel=angle(w.wind_direction_10m-m.bearing),head=w.wind_speed_10m*Math.cos(rel*Math.PI/180),cross=w.wind_speed_10m*Math.sin(rel*Math.PI/180);Object.assign(out,{wxBearing:m.bearing,wxRelative:rel,wxHead:head,wxApparent:Math.hypot(m.speed+head,cross),wxYaw:Math.atan2(Math.abs(cross),m.speed+head)*180/Math.PI});}return out;
 });
}
export function weatherSummary(a,{start=0,stop=a.streams?.at(-1)?.time||0}={}){
 const rows=a.streams||[],fields=Object.fromEntries(Object.keys(WEATHER_FIELDS).map(k=>[k,{seconds:0,sum:0,min:Infinity,max:-Infinity}])),world=Array(16).fill(0),relative=Array(16).fill(0);let covered=0,moving=0,windSeconds=0,head=0,tail=0,cross=0;
 for(let i=0;i<rows.length-1;i++){const r=rows[i],b=rows[i+1],dt=Math.min(stop,b.time)-Math.max(start,r.time);if(dt<=0||b.time-r.time>30||r.timerActive===false)continue;const motion=routeMotion(r,b);if(motion)moving+=dt;const w=weatherAt(a.weather?.samples,(Math.max(start,r.time)+Math.min(stop,b.time))/2);if(!w)continue;covered+=dt;
 for(const [k,s]of Object.entries(fields))if(Number.isFinite(w[k])){s.seconds+=dt;s.sum+=w[k]*dt;s.min=Math.min(s.min,w[k]);s.max=Math.max(s.max,w[k]);}
 if(motion&&Number.isFinite(w.wind_direction_10m)&&Number.isFinite(w.wind_speed_10m)&&w.wind_speed_10m>.1){const rel=angle(w.wind_direction_10m-motion.bearing);windSeconds+=dt;world[Math.round(angle(w.wind_direction_10m)/22.5)%16]+=dt;relative[Math.round(rel/22.5)%16]+=dt;if(rel<=45||rel>=315)head+=dt;else if(rel>=135&&rel<=225)tail+=dt;else cross+=dt;}
 }
 return {start,stop,covered,moving,windSeconds,windCoverage:moving?windSeconds/moving:0,headwind:windSeconds?head/windSeconds:null,tailwind:windSeconds?tail/windSeconds:null,crosswind:windSeconds?cross/windSeconds:null,world,relative,fields:Object.fromEntries(Object.entries(fields).map(([k,s])=>[k,s.seconds?{mean:s.sum/s.seconds,min:s.min,max:s.max,seconds:s.seconds}:null]))};
}
