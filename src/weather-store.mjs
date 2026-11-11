import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {WEATHER_FIELDS,validGps,activityStart,weatherEligibility,interpolateWeather,normalizeWeather} from './weather.mjs';
const fail=(status,message)=>Object.assign(Error(message),{status});
const fields=Object.keys(WEATHER_FIELDS);
export function decodeHourly(payload){
 const h=payload?.hourly;if(!h||!Array.isArray(h.time)||h.time.length<2||h.time.length>1008)throw fail(502,'天气服务未返回有效小时数据');
 let last=-Infinity;return h.time.map((time,i)=>{if(!Number.isFinite(time)||time<=last)throw fail(502,'天气时间轴无效');last=time;const out={time};for(const [key,[lo,hi]]of Object.entries(WEATHER_FIELDS)){if(!Array.isArray(h[key])||h[key].length!==h.time.length)throw fail(502,'天气字段不完整');const v=h[key][i];if(v===null)continue;if(!Number.isFinite(v)||v<lo||v>hi)throw fail(502,'天气数值无效');out[key]=v;}return out;});
}
function hourlyAt(rows,time){let i=rows.findIndex(r=>r.time>=time);if(i<0)return null;const b=rows[i];if(b.time===time)return b;const a=rows[i-1];return a&&b.time-a.time<=7200?interpolateWeather(a,b,(time-a.time)/(b.time-a.time)):null;}
export function createWeatherStore(dataDir,{fetcher=globalThis.fetch}={}){
 const directory=join(dataDir,'weather-cache');
 async function hourly(lat,lon,start,end,model,online){
 const endpoint=model==='forecast'?'https://api.open-meteo.com/v1/forecast':'https://historical-forecast-api.open-meteo.com/v1/forecast';
 const url=new URL(endpoint);for(const [k,v]of Object.entries({latitude:lat,longitude:lon,start_date:start,end_date:end,hourly:fields.join(','),wind_speed_unit:'ms',timezone:'GMT',timeformat:'unixtime'}))url.searchParams.set(k,v);
 const key=createHash('sha256').update(url.href).digest('hex'),file=join(directory,key+'.json');
 try{return decodeHourly(JSON.parse(await readFile(file,'utf8')));}catch{}
 if(!online)throw fail(404,'此路线与日期没有完整天气缓存，请点击“联网获取天气”');
 let payload;try{const response=await fetcher(url.href,{signal:AbortSignal.timeout(20000),redirect:'error'});if(!response.ok)throw Error('status '+response.status);const text=await response.text();if(text.length>2000000)throw Error('response too large');payload=JSON.parse(text);}catch{throw fail(502,'Open-Meteo 查询失败，请稍后重试；已保存天气不变');}
 const rows=decodeHourly(payload);if(!rows.some(r=>Number.isFinite(r.temperature_2m)&&Number.isFinite(r.wind_speed_10m)))throw fail(502,'此日期的天气尚不可用');
 await mkdir(directory,{recursive:true});const temporary=file+'.'+randomUUID()+'.tmp';await writeFile(temporary,JSON.stringify(payload));await rename(temporary,file);return rows;
 }
 return {async collect(a,{online=false}={}){
 const reason=weatherEligibility(a);if(reason)throw fail(400,reason);
 const startMs=Date.parse(activityStart(a)),route=a.streams.filter(validGps),selected=[];let prior=-Infinity;
 // Keep route samples at ~one-minute resolution, plus both endpoints. At most 721 for a 12 h ride.
 const step=Math.max(60,(route.at(-1).time-route[0].time)/700);
 for(const r of route)if(r.time-prior>=step){selected.push(r);prior=r.time;}
 if(selected.at(-1)!==route.at(-1))selected.push(route.at(-1));
 const anchors=[];for(let i=0;i<Math.min(8,selected.length);i++){const r=selected[Math.round(i*(selected.length-1)/Math.max(1,Math.min(8,selected.length)-1))],lat=Number(r.lat.toFixed(2)),lon=Number(r.lon.toFixed(2));if(!anchors.some(a=>a.lat===lat&&a.lon===lon))anchors.push({lat,lon});}
 const first=new Date(startMs+route[0].time*1000).toISOString().slice(0,10),last=new Date(startMs+route.at(-1).time*1000+3600000).toISOString().slice(0,10),model=startMs>=Date.now()-5*86400000?'forecast':'historical-forecast';
 let index=0;await Promise.all(Array.from({length:Math.min(2,anchors.length)},async()=>{while(index<anchors.length){const anchor=anchors[index++];anchor.hourly=await hourly(anchor.lat,anchor.lon,first,last,model,online);}}));
 const samples=selected.flatMap(r=>{const nearest=[...anchors].sort((a,b)=>((a.lat-r.lat)**2+((a.lon-r.lon)*Math.cos(r.lat*Math.PI/180))**2)-((b.lat-r.lat)**2+((b.lon-r.lon)*Math.cos(r.lat*Math.PI/180))**2))[0],w=hourlyAt(nearest.hourly,(startMs+r.time*1000)/1000);return w&&Number.isFinite(w.temperature_2m)?[{...w,time:r.time,lat:r.lat,lon:r.lon}]:[];});
 if(samples.length<2)throw fail(502,'此路线时段没有足够可用天气数据');
 return normalizeWeather({source:'Open-Meteo',model,startedAt:activityStart(a),retrievedAt:new Date().toISOString(),samples},a);
 }};
}
