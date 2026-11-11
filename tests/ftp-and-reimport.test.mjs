import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performanceEstimates,criticalPowerFit} from '../src/performance-estimates.mjs';
import {startServer} from '../src/server.mjs';
const point=(seconds,watts)=>({seconds,watts,start:0,end:seconds});
test('single-activity auto FTP selects the available method, can be overridden and never hides alternatives',()=>{
 const short=[point(300,330),point(480,310)],p8=performanceEstimates(short,70);assert.equal(p8.ftp.method,'p8');assert.equal(p8.ftp.value,279);assert.equal(p8.methods.find(m=>m.id==='p20').value,null);
 const p20=performanceEstimates([...short,point(1200,290)],70);assert.equal(p20.ftp.method,'p20');assert.equal(p20.ftp.value,275.5);
 const hour=[...short,point(1200,290),point(3600,280)];assert.equal(performanceEstimates(hour,70).ftp.method,'p60');assert.equal(performanceEstimates(hour,70,{method:'p20'}).ftp.value,275.5);assert.equal(performanceEstimates(short,70,{method:'p60'}).ftp,null);
 assert.equal(performanceEstimates([...hour.filter(p=>p.seconds!==3600),point(3600,180)],70).ftp.method,'p20');assert.equal(performanceEstimates([point(300,400)],70).ftp,null);
});
test('CP model recovers known CP and W prime, requires duration spread and rejects flat/inconsistent profiles',()=>{
 const curve=[180,300,480,600,720].map(t=>point(t,250+18000/t)),model=criticalPowerFit(curve),estimate=performanceEstimates(curve,70);assert.equal(model.available,true);assert.ok(Math.abs(model.cp-250)<1e-9);assert.ok(Math.abs(model.wPrime-18000)<1e-6);assert.ok(Math.abs(estimate.ftp.value-255)<1e-9);assert.equal(estimate.ftp.method,'cp');assert.equal(estimate.methods.find(m=>m.id==='p8').value,258.75);
 assert.equal(criticalPowerFit(curve.slice(0,2)).available,false);assert.equal(criticalPowerFit([300,480,600].map(t=>point(t,250))).available,false);assert.equal(criticalPowerFit([point(180,330),point(300,330),point(480,280),point(600,330)]).available,false);
});
async function withApi(fn){const dir=await mkdtemp(join(tmpdir(),'cycle-ftp-import-')),server=await startServer({dataDir:dir});const api=async(path,method='GET',body)=>{const r=await fetch(server.url+'/api'+path,{method,...(body===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(body)})});return {status:r.status,data:await r.json()};};try{await fn(api);}finally{await server.close();await rm(dir,{recursive:true,force:true});}}
const ride=(name,power,seconds=1200)=>({name,type:'Ride',date:'2026-11-10',duration:seconds/60,load:10,streams:Array.from({length:seconds+1},(_,time)=>({time,power}))});
test('FTP API uses exactly one activity, retains saved choice through backup and does not alter configured FTP/load',async()=>withApi(async api=>{
 const a=(await api('/activities','POST',ride('A',300))).data,b=(await api('/activities','POST',ride('B',600))).data,settings=(await api('/settings')).data;
 assert.equal((await api(`/activities/${a.id}/analysis`)).data.estimates.selectedReference.value,285);assert.equal((await api(`/activities/${b.id}/analysis`)).data.estimates.selectedReference.value,570);
 await api(`/activities/${a.id}`,'PUT',{ftpEstimateMethod:'p8'});assert.equal((await api(`/activities/${a.id}/analysis`)).data.estimates.selectedReference.value,270);
 assert.equal((await api(`/activities/${a.id}`,'PUT',{ftpEstimateMethod:'invented'})).status,400);
 const backup=(await api('/backup')).data;assert.equal((await api('/restore','POST',backup)).status,200);assert.equal((await api(`/activities/${a.id}`)).data.ftpEstimateMethod,'p8');assert.equal((await api(`/activities/${a.id}`)).data.load,10);assert.deepEqual((await api('/settings')).data,settings);assert.equal((await api('/power')).data.estimates,undefined);assert.equal((await api('/power?type=Run')).data.estimateActivities.length,0);
}));
test('deleted FIT can be reimported, extant edited activity still rejects duplicates, legacy stale registry self-recovers',async()=>withApi(async api=>{
 const bytes=await readFile(new URL('./fixtures/garmin-activity.fit',import.meta.url)),payload={filename:'ride.fit',content:bytes.toString('base64')};
 const first=await api('/import','POST',payload);assert.equal(first.status,201);const a=first.data.activities[0];await api(`/activities/${a.id}`,'PUT',{name:'Edited',load:77});assert.equal((await api('/import','POST',payload)).status,409);assert.equal((await api(`/activities/${a.id}`)).data.name,'Edited');
 const backup=(await api('/backup')).data;await api(`/activities/${a.id}`,'DELETE');assert.equal((await api('/import','POST',payload)).status,201);assert.equal((await api('/activities')).data.length,1);
 const stale={...backup,activities:[]};assert.equal((await api('/restore','POST',stale)).status,200);assert.equal((await api('/import','POST',payload)).status,201);assert.equal((await api('/activities')).data.length,1);
}));
test('multi-activity imports restore only deleted segments while preserving survivor edits, IDs and duplicate protection',async()=>withApi(async api=>{
 const payload={filename:'multi.csv',content:Buffer.from('date,name,type,duration,power\n2026-11-01,A,Ride,30,200\n2026-11-02,B,Ride,40,210\n').toString('base64')};const imported=await api('/import','POST',payload);assert.equal(imported.status,201);const [a,b]=imported.data.activities;
 await api(`/activities/${b.id}`,'PUT',{name:'Custom name',date:'2026-11-03',load:88,power:250});await api(`/activities/${a.id}`,'DELETE');const restored=await api('/import','POST',payload);assert.equal(restored.status,201);assert.equal(restored.data.count,1);assert.equal(restored.data.retained,1);assert.equal(restored.data.activities[0].importSessionIndex,0);assert.equal((await api('/activities')).data.length,2);assert.equal((await api(`/activities/${b.id}`)).data.load,88);assert.equal((await api(`/activities/${b.id}`)).data.name,'Custom name');assert.equal((await api('/import','POST',payload)).status,409);
 for(const a of (await api('/activities')).data)await api(`/activities/${a.id}`,'DELETE');assert.equal((await api('/import','POST',payload)).data.count,2);
}));
