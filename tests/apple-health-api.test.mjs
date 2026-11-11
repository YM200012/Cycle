import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startServer} from '../src/server.mjs';
const record=(type,unit,value,extra='')=>`<Record type="${type}" sourceName="Apple Watch" unit="${unit}" value="${value}" startDate="2026-11-09 07:00:00 +0800" endDate="2026-11-09 07:01:00 +0800" ${extra}/>`;
const xml=`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE HealthData [<!ELEMENT HealthData (Record|Workout)*><!ATTLIST Record type CDATA #REQUIRED>]><HealthData locale="zh_CN">${record('HKQuantityTypeIdentifierBodyMass','kg',70)}${record('HKQuantityTypeIdentifierRestingHeartRate','count/min',55)}${record('HKQuantityTypeIdentifierHeartRateVariabilitySDNN','ms',42)}${record('HKQuantityTypeIdentifierHeartRate','count/min',180)}<Workout workoutActivityType="HKWorkoutActivityTypeCycling" duration="60"/><Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Apple Watch" value="HKCategoryValueSleepAnalysisAsleepCore" startDate="2026-11-08 23:00:00 +0800" endDate="2026-11-09 07:00:00 +0800"/></HealthData>`;
async function run(fn){const dir=await mkdtemp(join(tmpdir(),'cycle-health-api-')),server=await startServer({dataDir:dir});const api=async(path,method='GET',body)=>{const r=await fetch(server.url+'/api'+path,{method,...(body===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(body)})});return {status:r.status,data:await r.json()};};const preview=async(content=xml)=>{const r=await fetch(server.url+'/api/wellness/apple-health/preview?from=2026-11-01&to=2026-11-10',{method:'POST',headers:{'content-type':'application/xml'},body:content});return {status:r.status,data:await r.json()};};try{await fn(api,preview);}finally{await server.close();await rm(dir,{recursive:true,force:true});}}
test('health preview is read-only, whitelist-only, default commit fills gaps and preserves manual notes/fatigue',async()=>run(async(api,preview)=>{
 await api('/wellness','POST',{date:'2026-11-09',weight:75,fatigue:3,notes:'manual'});const settings=(await api('/settings')).data,activities=(await api('/activities')).data;
 const p=await preview();assert.equal(p.status,200,JSON.stringify(p));assert.equal(p.data.days,1);assert.equal(p.data.fillFields,3);assert.equal(p.data.conflictFields,1);assert.equal(p.data.records[0].sleep,8);assert.equal((await api('/wellness')).data[0].hrv,undefined);
 const saved=await api('/wellness/apple-health/commit','POST',{token:p.data.token});assert.equal(saved.status,200);assert.equal(saved.data.fields,3);assert.equal(saved.data.activitiesCreated,0);
 const w=(await api('/wellness')).data[0];assert.equal(w.weight,75);assert.equal(w.restHr,55);assert.equal(w.hrv,42);assert.equal(w.sleep,8);assert.equal(w.fatigue,3);assert.equal(w.notes,'manual');assert.equal(w.sources.hrv.kind,'heartRateVariabilitySDNN');assert.ok(w.sources.hrv.importedAt);assert.equal(w.sources.weight,undefined);assert.deepEqual((await api('/activities')).data,activities);assert.deepEqual((await api('/settings')).data,settings);
 assert.equal((await api('/wellness/apple-health/commit','POST',{token:p.data.token})).status,410);
 const duplicate=await preview();const repeated=await api('/wellness/apple-health/commit','POST',{token:duplicate.data.token});assert.equal(repeated.data.fields,0);assert.equal((await api('/wellness')).data.length,1);
 const overwrite=await preview();assert.equal((await api('/wellness/apple-health/commit','POST',{token:overwrite.data.token,overwrite:true})).status,200);const replaced=(await api('/wellness')).data[0];assert.equal(replaced.weight,70);assert.equal(replaced.notes,'manual');assert.equal(replaced.fatigue,3);
 const backup=(await api('/backup')).data;assert.equal((await api('/restore','POST',backup)).status,200);assert.deepEqual((await api('/wellness')).data[0].sources,replaced.sources);
}));
test('health commit rejects stale preview atomically; malformed files never create wellness or activities',async()=>run(async(api,preview)=>{
 const p=await preview();assert.equal(p.status,200);await api('/wellness','POST',{date:'2026-11-09',notes:'edited after preview',sleep:7});assert.equal((await api('/wellness/apple-health/commit','POST',{token:p.data.token,overwrite:true})).status,409);assert.equal((await api('/wellness')).data[0].sleep,7);assert.equal((await api('/wellness')).data[0].weight,undefined);
 assert.equal((await preview(xml.replace('</HealthData>',''))).status,400);assert.equal((await preview('<not-health/>')).status,400);assert.equal((await api('/activities')).data.length,0);assert.equal((await api('/wellness')).data.length,1);
}));
test('upload inventory then select dates and types; monthly revisions replace owned values and preserve manual entries',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'cycle-health-monthly-')),server=await startServer({dataDir:dir});
 const api=async(path,method='GET',value)=>{const r=await fetch(server.url+'/api/wellness/apple-health'+path,{method,...(value===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(value)})});return {status:r.status,data:await r.json()};};
 const upload=async content=>{const r=await fetch(server.url+'/api/wellness/apple-health/inspect',{method:'POST',headers:{'content-type':'application/xml'},body:content});return {status:r.status,data:await r.json()};};
 const well=async(value)=>{const r=await fetch(server.url+'/api/wellness',{method:value?'POST':'GET',...(value?{headers:{'content-type':'application/json'},body:JSON.stringify(value)}:{})});return r.json();};
 try{
  const inspected=await upload(xml);assert.equal(inspected.status,200,JSON.stringify(inspected));assert.equal(inspected.data.typeCount,5);assert.equal(inspected.data.workoutsIgnored,1);assert.equal(inspected.data.types.filter(t=>t.supported).length,5);assert.deepEqual(await well(),[]);
  assert.equal((await api('/preview','POST',{uploadToken:inspected.data.uploadToken,from:'2026-11-01',to:'2026-11-10',types:[]})).status,400);
  const p=await api('/preview','POST',{uploadToken:inspected.data.uploadToken,from:'2026-11-01',to:'2026-11-10',types:['hrv','restHr']});assert.equal(p.status,200,JSON.stringify(p));assert.equal(p.data.records[0].weight,undefined);assert.equal(p.data.fillFields,2);
  assert.equal((await api('/commit','POST',{token:p.data.token})).data.fields,2);assert.equal((await api('/preview','POST',{uploadToken:inspected.data.uploadToken,from:'2026-11-01',to:'2026-11-10',types:['hrv']})).status,410);
  const first=(await well())[0];await well({...first,restHr:60,notes:'manual edit'});
  const revised=xml.replace('value="42"','value="48"').replace('value="55"','value="57"');const inspected2=await upload(revised);assert.equal(inspected2.data.lastImport.to,'2026-11-10');
  const p2=await api('/preview','POST',{uploadToken:inspected2.data.uploadToken,from:'2026-11-01',to:'2026-11-10',types:['hrv','restHr']});assert.equal(p2.data.updateFields,1);assert.equal(p2.data.protectedFields,1);
  const c2=await api('/commit','POST',{token:p2.data.token});assert.equal(c2.data.fields,1);const second=(await well())[0];assert.equal(second.hrv,48);assert.equal(second.restHr,60);assert.equal(second.notes,'manual edit');assert.equal(second.weight,undefined);
  const inspected3=await upload(revised),p3=await api('/preview','POST',{uploadToken:inspected3.data.uploadToken,from:'2026-11-01',to:'2026-11-10',types:['hrv']});assert.equal(p3.data.unchangedFields,1);assert.equal((await api('/commit','POST',{token:p3.data.token})).data.fields,0);assert.equal((await well()).length,1);
  assert.equal((await api('/history')).data.length,3);const backup=await (await fetch(server.url+'/api/backup')).json();assert.equal(backup.healthImports.length,3);
  const cancelled=await upload(xml);assert.equal((await api('/upload/'+cancelled.data.uploadToken,'DELETE')).status,200);assert.equal((await api('/preview','POST',{uploadToken:cancelled.data.uploadToken,from:'2026-11-01',to:'2026-11-10',types:['hrv']})).status,410);
  assert.equal((await upload('<HealthData>')).status,400);
 }finally{await server.close();await rm(dir,{recursive:true,force:true});}
});
test('monthly partial export cannot automatically lower existing daily aggregate coverage',async()=>run(async(api,preview)=>{
 const extra=record('HKQuantityTypeIdentifierHeartRateVariabilitySDNN','ms',60).replaceAll('07:00:00','09:00:00').replaceAll('07:01:00','09:01:00');
 const complete=xml.replace('</HealthData>',extra+'</HealthData>'),p=await preview(complete);assert.equal(p.data.records[0].hrv,51);await api('/wellness/apple-health/commit','POST',{token:p.data.token});
 const partial=await preview(xml);assert.equal(partial.data.protectedFields,1);await api('/wellness/apple-health/commit','POST',{token:partial.data.token});assert.equal((await api('/wellness')).data[0].hrv,51);
}));
test('unchanged aggregate advances coverage so later partial changed samples remain protected',async()=>run(async(api,preview)=>{
 const initial=await preview();await api('/wellness/apple-health/commit','POST',{token:initial.data.token});
 const extra=record('HKQuantityTypeIdentifierHeartRateVariabilitySDNN','ms',42).replaceAll('07:00:00','09:00:00').replaceAll('07:01:00','09:01:00');
 const fuller=await preview(xml.replace('</HealthData>',extra+'</HealthData>'));assert.equal(fuller.data.updateFields,0);await api('/wellness/apple-health/commit','POST',{token:fuller.data.token});
 const stored=(await api('/wellness')).data[0];assert.equal(stored.sources.hrv.coverage.sampleCount,2);
 const narrower=await preview(xml.replace('value="42"','value="50"'));assert.equal(narrower.data.protectedFields,1);await api('/wellness/apple-health/commit','POST',{token:narrower.data.token});assert.equal((await api('/wellness')).data[0].hrv,42);
}));

test('all health channels persist independently, repeat safely, protect manual values, and survive backups',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'cycle-health-all-')),server=await startServer({dataDir:dir});
 const api=async(path,method='GET',value)=>{const r=await fetch(server.url+'/api'+path,{method,...(value===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(value)})});return {status:r.status,data:await r.json()};};
 const upload=async text=>{const r=await fetch(server.url+'/api/wellness/apple-health/inspect',{method:'POST',headers:{'content-type':'application/xml'},body:text});return {status:r.status,data:await r.json()};};
 const q=(type,unit,value,hour='07')=>`<Record type="${type}" sourceName="Watch" unit="${unit}" value="${value}" startDate="2026-11-09 ${hour}:00:00 +0800" endDate="2026-11-09 ${hour}:01:00 +0800"/>`;
 const step='HKQuantityTypeIdentifierStepCount',future='HKQuantityTypeIdentifierFutureMetric',category='HKCategoryTypeIdentifierFutureEvent';
 const text=`<HealthData>${q(step,'count',100)}${q(step,'count',200,'08')}${q(future,'custom',2)}${q(future,'custom',4,'08')}${q(future,'other',10)}<Record type="${category}" sourceName="Watch" value="HKCategoryValueFutureYes" startDate="2026-11-09 07:00:00 +0800" endDate="2026-11-09 07:00:00 +0800"/>${q('HKQuantityTypeIdentifierBodyMass','kg',70)}<Workout/></HealthData>`;
 async function prepare(content,types=[step,future,category]){const inspected=await upload(content);assert.equal(inspected.status,200,JSON.stringify(inspected));const p=await api('/wellness/apple-health/preview','POST',{uploadToken:inspected.data.uploadToken,from:'2026-11-09',to:'2026-11-09',types});assert.equal(p.status,200,JSON.stringify(p));return p.data;}
 try{
  const p=await prepare(text);assert.equal(p.records[0].weight,undefined);assert.equal(p.records[0].healthMetrics.length,4);assert.deepEqual((await api('/wellness')).data,[]);assert.equal((await api('/wellness/apple-health/commit','POST',{token:p.token})).status,200);
  const first=(await api('/wellness')).data[0],steps=first.healthMetrics.find(m=>m.type===step),mean=first.healthMetrics.find(m=>m.type===future&&m.unit==='custom'),event=first.healthMetrics.find(m=>m.type===category);
  assert.equal(steps.value,300);assert.equal(mean.value,3);assert.equal(event.value,1);assert.equal(steps.provider,'Apple Health');assert.ok(steps.importedAt);assert.equal(mean.sampleCount,2);assert.ok(mean.start<=mean.end);assert.equal(first.healthMetrics.filter(m=>m.type===future).length,2);
  const repeat=await prepare(text),again=await api('/wellness/apple-health/commit','POST',{token:repeat.token});assert.equal(again.data.fields,0);assert.equal((await api('/wellness')).data.length,1);
  const manual=await api('/wellness','POST',{date:first.date,notes:'keep generic',fatigue:3});assert.equal(manual.data.healthMetrics.length,4);assert.equal(manual.data.healthMetrics.find(m=>m.id===steps.id).provider,'Apple Health');
  const changed=await prepare(text.replace('value="4"','value="6"'),[future]);assert.equal(changed.updateFields,1);await api('/wellness/apple-health/commit','POST',{token:changed.token});const second=(await api('/wellness')).data[0];assert.equal(second.healthMetrics.find(m=>m.id===mean.id).value,4);assert.equal(second.healthMetrics.find(m=>m.id===steps.id).value,300);assert.equal(second.notes,'keep generic');
  const edited=await api('/wellness','POST',{...second,healthMetrics:second.healthMetrics.map(m=>m.id===mean.id?{...m,value:77,provider:'Apple Health'}:m)});assert.equal(edited.data.healthMetrics.find(m=>m.id===mean.id).provider,undefined);
  const next=await prepare(text,[future]);assert.equal(next.protectedFields,1);await api('/wellness/apple-health/commit','POST',{token:next.token});assert.equal((await api('/wellness')).data[0].healthMetrics.find(m=>m.id===mean.id).value,77);
  const backup=(await api('/backup')).data;assert.equal((await api('/restore','POST',backup)).status,200);assert.deepEqual((await api('/wellness')).data,backup.wellness);assert.equal((await api('/activities')).data.length,0);
  const invalid={...backup,wellness:backup.wellness.map(r=>({...r,healthMetrics:r.healthMetrics.map((m,i)=>i?m:{...m,value:Infinity})}))};assert.equal((await api('/restore','POST',invalid)).status,400);assert.deepEqual((await api('/wellness')).data,backup.wellness);
 }finally{await server.close();await rm(dir,{recursive:true,force:true});}
});

test('health staging is emptied on commit, cancel, malformed parse and expiry',async()=>{
 const {readdir}=await import('node:fs/promises');const dir=await mkdtemp(join(tmpdir(),'cycle-health-clean-')),server=await startServer({dataDir:dir,healthUploadTtlMs:250});
 const api=async(path,method='GET',value)=>{const r=await fetch(server.url+'/api/wellness/apple-health'+path,{method,...(value===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(value)})});return {status:r.status,data:await r.json()};};
 const upload=async text=>{const r=await fetch(server.url+'/api/wellness/apple-health/inspect',{method:'POST',headers:{'content-type':'application/xml'},body:text});return {status:r.status,data:await r.json()};};
 const files=()=>readdir(join(dir,'.health-staging'));
 try{
  const first=await upload(xml);assert.equal((await files()).length,1);const p=await api('/preview','POST',{uploadToken:first.data.uploadToken,from:'2026-11-01',to:'2026-11-10',types:['hrv']});assert.equal(p.status,200);await api('/commit','POST',{token:p.data.token});assert.deepEqual(await files(),[]);
  const second=await upload(xml);await api('/upload/'+second.data.uploadToken,'DELETE');assert.deepEqual(await files(),[]);
  assert.equal((await upload('<HealthData>')).status,400);assert.deepEqual(await files(),[]);
  const third=await upload(xml);const fourth=await upload(xml);assert.equal((await files()).length,1);assert.equal((await api('/preview','POST',{uploadToken:third.data.uploadToken,types:['hrv']})).status,410);
  await new Promise(resolve=>setTimeout(resolve,300));assert.equal((await api('/preview','POST',{uploadToken:fourth.data.uploadToken,types:['hrv']})).status,410);assert.deepEqual(await files(),[]);
 }finally{await server.close();await rm(dir,{recursive:true,force:true});}
});
