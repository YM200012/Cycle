import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {performanceEstimates} from '../src/performance-estimates.mjs';
import {powerAnalysis,defaults} from '../src/metrics.mjs';
import {weatherAt,weatherSummary,weatherRows,interpolateWeather,normalizeWeather,weatherEligibility,WEATHER_FIELDS} from '../src/weather.mjs';
import {createWeatherStore,decodeHourly} from '../src/weather-store.mjs';
import {startServer} from '../src/server.mjs';
const start='2026-10-01T00:30:00.000Z';
const ride=()=>({name:'天气测试',type:'Ride',date:'2026-10-01',startedAt:start,duration:20,load:12,streams:Array.from({length:1201},(_,time)=>({time,lat:31.2+time*.00001,lon:121.45,power:300,speed:8}))});
function payload(){const time=Array.from({length:49},(_,i)=>Date.parse('2026-10-01T00:00:00Z')/1000+i*3600);return {hourly:{time,...Object.fromEntries(Object.keys(WEATHER_FIELDS).map(k=>[k,time.map(()=>({temperature_2m:20,apparent_temperature:19,relative_humidity_2m:60,wind_speed_10m:5,wind_direction_10m:0,wind_gusts_10m:8,cloud_cover:50,rain:0,snowfall:0,weather_code:1})[k])]))}};}
const attach=a=>({...a,weather:{source:'Open-Meteo',model:'historical-forecast',startedAt:a.startedAt,retrievedAt:new Date().toISOString(),samples:[a.streams[0],a.streams[600],a.streams.at(-1)].map(r=>({...r,temperature_2m:20,wind_speed_10m:5,wind_direction_10m:0}))}});
test('power estimates use complete corrected efforts, require durations and preserve source',()=>{
 const a=ride(),curve=powerAnalysis([a],defaults).curve,e=performanceEstimates(curve,75);assert.equal(e.ftp.value,285);assert.equal(e.vo2max.value,50.2);assert.equal(e.ftp.effort.start,0);assert.equal(e.ftp.effort.end,1200);assert.equal(performanceEstimates(curve,0).vo2max,null);
 const short=powerAnalysis([{...a,streams:a.streams.slice(0,301)}],defaults).curve;assert.equal(performanceEstimates(short,75).ftp,null);assert.equal(performanceEstimates(short,75).vo2max.value,50.2);
 const gap=powerAnalysis([{...a,powerCorrections:[{time:600,power:null}]}],defaults).curve;assert.equal(performanceEstimates(gap,75).methods.find(m=>m.id==='p20').value,null);assert.equal(a.streams[600].power,300);
});
test('weather eligibility excludes virtual indoor planned, absent GPS/time and future rides',()=>{
 const a=ride();assert.equal(weatherEligibility(a),'');for(const patch of [{indoor:true},{planned:true},{startedAt:undefined},{streams:[{time:0}]},{startedAt:'2200-01-01T00:00:00Z'},{notes:'FIT 经 Garmin 官方 SDK 解码，虚拟骑行：路线、速度与海拔为训练平台记录'}])assert.ok(weatherEligibility({...a,...patch}));
});
test('wind interpolation wraps north and never extrapolates, missing values do not become zero',()=>{
 const a={time:0,wind_speed_10m:5,wind_direction_10m:359,temperature_2m:10},b={time:60,wind_speed_10m:5,wind_direction_10m:1};const w=interpolateWeather(a,b,.5);assert.ok(w.wind_direction_10m<1||w.wind_direction_10m>359);assert.equal(w.temperature_2m,undefined);assert.equal(weatherAt([a,b],-1),null);assert.equal(weatherAt([a,{...b,time:900}],500),null);
});
test('head-tail proportions and wind roses use moving seconds, zoom ranges and pauses',()=>{
 const a=attach(ride()),s=weatherSummary(a);assert.equal(s.headwind,1);assert.equal(s.tailwind,0);assert.equal(s.windSeconds,1200);assert.equal(s.world[0],1200);assert.equal(s.fields.temperature_2m.mean,20);
 assert.equal(weatherSummary(a,{start:100,stop:200}).covered,100);
 const reversed={...a,streams:a.streams.map(r=>({...r,lat:31.3-r.time*.00001}))};assert.equal(weatherSummary(reversed).tailwind,1);
 const paused={...a,streams:a.streams.map(r=>({...r,timerActive:r.time<600}))};assert.equal(weatherSummary(paused).moving,600);
 const row=weatherRows(a)[0];assert.equal(row.wxHead,5);assert.equal(row.wxApparent,13);assert.equal(row.wxYaw,0);
 const missing={...a,weather:{...a.weather,samples:a.weather.samples.map(s=>({time:s.time,lat:s.lat,lon:s.lon,temperature_2m:20}))}};assert.equal(weatherSummary(missing).headwind,null);assert.equal(weatherSummary(missing).fields.rain,null);
});
test('weather normalization binds exact timestamp and GPS, rejects invalid numeric data',()=>{
 const a=attach(ride());assert.equal(normalizeWeather(a.weather,a).samples.length,3);assert.throws(()=>normalizeWeather({...a.weather,startedAt:'2026-10-02'},a));assert.throws(()=>normalizeWeather({...a.weather,samples:a.weather.samples.map(s=>({...s,lat:0}))},a));assert.throws(()=>normalizeWeather({...a.weather,samples:[{...a.weather.samples[0],wind_speed_10m:-5}]},a));assert.throws(()=>decodeHourly({hourly:{time:[1,0]}}));
});
test('weather provider cache works offline, only sends quantized coordinates/date, preserves raw sensor data',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'cycle-weather-'));let calls=0;const store=createWeatherStore(dir,{fetcher:async u=>{const url=new URL(u);assert.equal(url.hostname,'historical-forecast-api.open-meteo.com');assert.equal(url.searchParams.get('timezone'),'GMT');assert.equal(url.searchParams.get('start_date'),'2026-10-01');assert.equal(url.searchParams.get('latitude'),Number(Number(url.searchParams.get('latitude')).toFixed(2)).toString());calls++;return new Response(JSON.stringify(payload()));}});
 try{const a=ride(),raw=JSON.stringify(a);await assert.rejects(store.collect(a),{status:404});const w=await store.collect(a,{online:true});assert.ok(calls>0&&calls<=8);assert.equal(w.samples[0].temperature_2m,20);assert.equal(w.samples.at(-1).time,1200);const count=calls;assert.deepEqual((await store.collect(a)).samples,w.samples);assert.equal(calls,count);assert.equal(JSON.stringify(a),raw);await assert.rejects(store.collect({...a,indoor:true},{online:true}),{status:400});}finally{await rm(dir,{recursive:true,force:true});}
});
test('weather and estimates API round-trip backups without updating FTP/load, reject stale network results',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'cycle-weather-api-'));let unblock,started,gate=false;const entered=new Promise(r=>started=r);const server=await startServer({dataDir:dir,weatherFetcher:async()=>{if(gate){gate=false;started();await new Promise(r=>unblock=r);}return new Response(JSON.stringify(payload()));}});
 const api=async(path,method='GET',data)=>{const r=await fetch(server.url+'/api'+path,{method,...(data===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(data)})});return {status:r.status,data:await r.json()};};
 try{assert.equal((await api('/activities','POST',{...ride(),startedAt:'2026-10-01'})).status,400);const a=(await api('/activities','POST',ride())).data,b=(await api('/activities','POST',{...ride(),type:'Run',streams:ride().streams.map(r=>({...r,power:900}))})).data;
 assert.equal((await api('/power')).data.estimates,undefined);assert.deepEqual((await api('/power')).data.estimateActivities.map(a=>a.id),[a.id]);assert.equal((await api(`/activities/${a.id}/analysis`)).data.estimates.selectedReference.value,285);const settings=(await api('/settings')).data;
 assert.equal((await api(`/activities/${a.id}/weather`,'POST',{online:false})).status,404);const weather=await api(`/activities/${a.id}/weather`,'POST',{online:true});assert.equal(weather.status,200);assert.equal(weather.data.load,12);assert.deepEqual(weather.data.streams,a.streams);
 const backup=(await api('/backup')).data;assert.equal((await api('/restore','POST',backup)).status,200);assert.deepEqual((await api(`/activities/${a.id}`)).data.weather,weather.data.weather);assert.deepEqual((await api('/settings')).data,settings);
 assert.equal((await api(`/activities/${a.id}/weather`)).data.summary.headwind,1);assert.equal((await api(`/activities/${a.id}/weather`,'DELETE')).data.weather,undefined);
 const c=(await api('/activities','POST',{...ride(),streams:ride().streams.map(r=>({...r,lon:100}))})).data;gate=true;const pending=api(`/activities/${c.id}/weather`,'POST',{online:true});await entered;await api(`/activities/${c.id}`,'PUT',{notes:'查询期间修改'});gate=false;unblock();assert.equal((await pending).status,409);assert.equal((await api(`/activities/${c.id}`)).data.weather,undefined);
 }finally{await server.close();await rm(dir,{recursive:true,force:true});}
});
