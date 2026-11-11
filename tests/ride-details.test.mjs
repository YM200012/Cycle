import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Encoder,Profile} from '@garmin/fitsdk';
import {rideDetails,rideSpeedStreams,normalizeFitSummary,normalizeFitDevices} from '../src/ride-details.mjs';
import {importFIT} from '../src/fit.mjs';
import {startServer} from '../src/server.mjs';

test('ride statistics weight irregular samples, preserve zero and exclude pauses and missing gaps',()=>{
  const activity={duration:2,distance:1,streams:[{time:0,speed:0,power:0,temperature:0,altitude:10},{time:5,speed:10,power:200,temperature:20,altitude:15},{time:15,speed:90,power:999,timerActive:false,altitude:999},{time:20,speed:5,power:100,altitude:12},{time:25,speed:100,power:500},{time:100,speed:8,power:160},{time:110,speed:9,power:180}]};
  const before=structuredClone(activity),r=rideDetails(activity);
  assert.equal(r.metrics.avgSpeed.value,(0*5+10*10+5*5+8*10)/30*3.6);
  assert.equal(r.metrics.avgPower.value,(0*5+200*10+100*5+160*10)/30);
  assert.equal(r.metrics.avgTemperature.value,200/15);
  assert.equal(r.metrics.ascent.value,5);assert.equal(r.metrics.descent.value,0);
  assert.equal(r.metrics.timerSeconds.value,null);assert.equal(r.metrics.pausedSeconds.value,null);
  assert.equal(r.metrics.calories.value,null);assert.equal(r.coverage.speed,30);
  assert.equal(r.speedSource,'recorded');assert.deepEqual(activity,before);
});

test('speed inference is adjacent-only, marks provenance, and never crosses pauses, gaps or distance resets',()=>{
  const a={streams:[{time:0,distance:0},{time:10,distance:100},{time:20,distance:50},{time:60,distance:400},{time:65,distance:450,timerActive:false},{time:70,distance:500},{time:80,distance:600,speed:0}]};
  const rows=rideSpeedStreams(a);
  assert.equal(rows[0].speed,10);assert.equal(rows[0].speedSource,'distance');
  assert.equal(rows[1].speed,undefined);assert.equal(rows[2].speed,undefined);assert.equal(rows[3].speed,undefined);assert.equal(rows[4].speed,undefined);
  assert.equal(rows[5].speed,10);assert.equal(rows[6].speed,0);
  assert.equal(rideDetails(a).speedSource,'mixed');
  assert.equal(rideDetails({}).metrics.avgSpeed.value,null);
});

test('device summary wins without manufacturing missing measurements or treating unknown side as left',()=>{
  const a={duration:1,fitSummary:{elapsedSeconds:60,timerSeconds:50,movingSeconds:45,avgSpeed:8,maxSpeed:12,ascent:100,avgPower:220,avgBalance:49,calories:0},streams:[{time:0,speed:10,power:100},{time:10,speed:10,power:100}]};
  const r=rideDetails(a);assert.equal(r.metrics.avgSpeed.value,28.8);assert.equal(r.metrics.maxSpeed.value,43.2);assert.equal(r.metrics.avgSpeed.source,'device');assert.equal(r.metrics.pausedSeconds.value,10);assert.equal(r.metrics.avgPower.value,220);assert.equal(r.metrics.ascent.value,100);assert.equal(r.metrics.balance.value,49);assert.equal(r.metrics.calories.value,0);assert.equal(r.metrics.maxHr.value,null);
  assert.throws(()=>normalizeFitSummary({timerSeconds:20,elapsedSeconds:10}));assert.throws(()=>normalizeFitSummary({avgSpeed:null}));assert.throws(()=>normalizeFitSummary({startedAt:'2026-02-30T00:00:00.000Z'}));assert.throws(()=>normalizeFitDevices([{manufacturer:123}]));
});

function detailedFit(){const t=s=>new Date(Date.parse('2026-11-01T12:00:00Z')+s*1000),encoder=new Encoder();encoder.onMesg(Profile.MesgNum.FILE_ID,{type:'activity',manufacturer:'garmin',product:1,timeCreated:t(0)});encoder.onMesg(Profile.MesgNum.DEVICE_INFO,{timestamp:t(0),manufacturer:'garmin',product:1,productName:'Test Bike Computer',softwareVersion:12.3,serialNumber:12345});for(const s of [0,5,10])encoder.onMesg(Profile.MesgNum.RECORD,{timestamp:t(s),distance:s*10,speed:10,power:200,temperature:22,grade:2.5,leftRightBalance:0x80|52});encoder.onMesg(Profile.MesgNum.SESSION,{startTime:t(0),timestamp:t(10),totalElapsedTime:10,totalTimerTime:8,totalMovingTime:7,totalDistance:100,sport:'cycling',enhancedAvgSpeed:9,enhancedMaxSpeed:12,totalAscent:30,totalDescent:10,totalCalories:123,avgCadence:88,maxCadence:110,avgHeartRate:140,maxHeartRate:170,avgPower:210,maxPower:500,avgTemperature:22,maxTemperature:25,totalTrainingEffect:3.2,totalAnaerobicTrainingEffect:1.1,leftRightBalance:0x8000|5200,totalWork:2100});return Buffer.from(encoder.close());}

test('FIT retains device session units, environment, balance and equipment without serial numbers',()=>{
  const [a]=importFIT('detailed.fit',detailedFit(),{ftp:250});
  assert.equal(a.fitSummary.startedAt,'2026-11-01T12:00:00.000Z');assert.equal(a.fitSummary.timerSeconds,8);assert.equal(a.fitSummary.avgSpeed,9);assert.equal(a.fitSummary.maxSpeed,12);assert.equal(a.fitSummary.ascent,30);assert.equal(a.fitSummary.calories,123);assert.equal(a.fitSummary.avgBalance,48);assert.equal(a.fitSummary.workKj,2.1);assert.equal(a.fitSummary.aerobicEffect,3.2);assert.equal(a.fitSummary.anaerobicEffect,1.1);
  assert.equal(a.streams[0].temperature,22);assert.equal(a.streams[0].grade,2.5);assert.equal(a.streams[0].balance,48);assert.equal(a.fitDevices[0].name,'Test Bike Computer');assert.equal(a.fitDevices[0].serialNumber,undefined);
});

test('rich FIT fields survive API editing and backup restore; invalid metadata rejects atomically',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'cycle-fit-detail-')),server=await startServer({dataDir:dir});
  const api=async(path,method='GET',data)=>{const r=await fetch(server.url+'/api'+path,{method,headers:{'content-type':'application/json'},...(data===undefined?{}:{body:JSON.stringify(data)})});return {status:r.status,data:await r.json()};};
  try{const [a]=importFIT('details.fit',detailedFit(),{ftp:250});const saved=await api('/activities','POST',a);assert.equal(saved.status,201);assert.equal(saved.data.fitSummary.avgSpeed,9);assert.equal(saved.data.streams[0].temperature,22);const id=saved.data.id;const edited=await api('/activities/'+id,'PUT',{name:'Renamed'});assert.deepEqual(edited.data.fitSummary,a.fitSummary);assert.deepEqual(edited.data.fitDevices,a.fitDevices);const backup=(await api('/backup')).data;assert.equal((await api('/restore','POST',backup)).status,200);assert.equal((await api('/activities/'+id)).data.fitSummary.avgBalance,48);const bad=structuredClone(backup);bad.activities[0].fitSummary.avgSpeed=-1;assert.equal((await api('/restore','POST',bad)).status,400);assert.equal((await api('/activities/'+id)).data.fitSummary.avgSpeed,9);assert.equal((await api('/activities/'+id,'PUT',{fitDevices:null})).status,400);}
  finally{await server.close();await rm(dir,{recursive:true,force:true});}
});

async function testServer(fn){const dir=await mkdtemp(join(tmpdir(),'cycle-fit-enrich-')),server=await startServer({dataDir:dir});const api=async(path,method='GET',data)=>{const r=await fetch(server.url+'/api'+path,{method,headers:{'content-type':'application/json'},...(data===undefined?{}:{body:JSON.stringify(data)})});return {status:r.status,data:await r.json()};};try{await fn(api);}finally{await server.close();await rm(dir,{recursive:true,force:true});}}

test('explicit FIT enrichment upgrades uniquely matched legacy records and preserves IDs, corrections and associations',async()=>testServer(async api=>{
  const payload={filename:'riding.fit',content:detailedFit().toString('base64')},first=await api('/import','POST',payload),id=first.data.activities[0].id;
  assert.match(first.data.activities[0].importHash,/^[a-f0-9]{64}$/);assert.equal(first.data.activities[0].importSessionIndex,0);
  const g=(await api('/gear','POST',{name:'Bike',type:'Ride'})).data;
  await api('/activities/'+id,'PUT',{name:'My own title',date:'2026-11-02',gearId:g.id,load:42});
  await api('/activities/'+id+'/power-corrections','PUT',{corrections:[{time:0,power:123}]});
  const goal=(await api('/goals','POST',{name:'Race',date:'2026-11-02',type:'Ride',priority:'A',activityId:id})).data;
  const plan=(await api('/plans','POST',{name:'Plan',weeks:1,entries:[{id:'entry',day:0,name:'Ride',type:'Ride',duration:1,load:1}]})).data;
  const batch=(await api('/plans/'+plan.id+'/schedule','POST',{startDate:'2026-11-02'})).data;
  await api('/planning/match','POST',{plannedId:batch.activities[0].id,actualId:id});
  const legacy=(await api('/backup')).data,original=legacy.activities.find(a=>a.id===id);
  delete original.fitSummary;delete original.fitDevices;delete original.importHash;delete original.importSessionIndex;
  for(const s of original.streams){delete s.temperature;delete s.grade;delete s.balance;}
  await api('/restore','POST',legacy);
  const duplicate=await api('/import','POST',payload);assert.equal(duplicate.status,409);assert.equal(duplicate.data.code,'DUPLICATE_IMPORT');assert.equal((await api('/activities/'+id)).data.fitSummary,undefined);
  const enriched=await api('/import','POST',{...payload,enrichExisting:true});assert.equal(enriched.status,200);assert.equal(enriched.data.enriched,true);assert.equal(enriched.data.count,1);
  const after=(await api('/activities/'+id)).data;
  assert.equal(after.id,id);assert.equal(after.name,'My own title');assert.equal(after.date,'2026-11-02');assert.equal(after.gearId,g.id);assert.equal(after.load,42);assert.deepEqual(after.powerCorrections,[{time:0,power:123}]);assert.equal(after.streams[0].power,200);assert.equal(after.streams[0].temperature,22);assert.equal(after.fitSummary.calories,123);
  assert.equal((await api('/goals/'+goal.id)).data.activityId,id);assert.equal((await api('/activities/'+batch.activities[0].id)).data.completionId,id);
  await api('/activities/'+id,'PUT',{fitSummary:{...after.fitSummary,calories:999}});await api('/import','POST',{...payload,enrichExisting:true});assert.equal((await api('/activities/'+id)).data.fitSummary.calories,999);
}));

function multiFit(){const t=s=>new Date(Date.parse('2026-11-01T12:00:00Z')+s*1000),e=new Encoder();e.onMesg(Profile.MesgNum.FILE_ID,{type:'activity',manufacturer:'development',product:1,timeCreated:t(0)});for(const start of [0,20]){for(const s of [0,5,10])e.onMesg(Profile.MesgNum.RECORD,{timestamp:t(start+s),power:200+start,speed:10,temperature:22});e.onMesg(Profile.MesgNum.SESSION,{startTime:t(start),timestamp:t(start+10),sport:'cycling',totalElapsedTime:10,totalTimerTime:10,totalCalories:50});}return Buffer.from(e.close());}
test('FIT enrichment is atomic on changed samples, missing sessions and ambiguous legacy candidates',async()=>testServer(async api=>{
  const payload={filename:'multi.fit',content:multiFit().toString('base64')},imported=await api('/import','POST',payload),ids=imported.data.activities.map(a=>a.id),backup=(await api('/backup')).data;
  for(const a of backup.activities){delete a.fitSummary;delete a.fitDevices;for(const s of a.streams)delete s.temperature;}
  const mismatch=structuredClone(backup);mismatch.activities[1].streams[0].power=999;await api('/restore','POST',mismatch);
  assert.equal((await api('/import','POST',{...payload,enrichExisting:true})).status,400);assert.equal((await api('/activities/'+ids[0])).data.fitSummary,undefined);
  await api('/restore','POST',backup);await api('/activities/'+ids[1],'DELETE');assert.equal((await api('/import','POST',{...payload,enrichExisting:true})).status,400);assert.equal((await api('/activities/'+ids[0])).data.fitSummary,undefined);
  const ambiguous=structuredClone(backup);for(const a of ambiguous.activities){delete a.importHash;delete a.importSessionIndex;}ambiguous.activities.push({...structuredClone(ambiguous.activities[0]),id:'another-copy'});await api('/restore','POST',ambiguous);assert.equal((await api('/import','POST',{...payload,enrichExisting:true})).status,400);assert.equal((await api('/activities/'+ids[0])).data.fitSummary,undefined);
  assert.equal((await api('/import','POST',{filename:'new.fit',content:detailedFit().toString('base64'),enrichExisting:true})).status,400);
}));
