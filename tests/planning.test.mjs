import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {normalizePlan,schedulePlan} from '../src/planning.mjs';import {startServer} from '../src/server.mjs';
const entry=(day=0)=>({id:'entry-'+day,day,name:'阈值训练',type:'Ride',duration:60,load:70,intervals:[{duration:60,power:90}],notes:'保持节奏'});
const plan=()=>({name:'两周计划',description:'周期说明',weeks:2,entries:[entry(0),entry(3),entry(7)]});
async function withServer(fn){const dir=await mkdtemp(join(tmpdir(),'cycle-planning-'));const server=await startServer({dataDir:dir});const api=async(path,method='GET',data)=>{const r=await fetch(server.url+'/api'+path,{method,headers:{'content-type':'application/json'},...(data===undefined?{}:{body:JSON.stringify(data)})});return {status:r.status,data:await r.json()};};try{await fn(api,server,dir);}finally{await server.close();await rm(dir,{recursive:true,force:true});}}
test('cycle plan validates dates, ranges and unique entries; scheduling crosses months correctly',()=>{
 const normalized=normalizePlan(plan(),'plan');const s=schedulePlan(normalized,'2026-12-28');assert.equal(s.activities[2].date,'2027-01-04');assert.equal(s.activities[0].planOrigin.startDate,'2026-12-28');
 for(const invalid of [{...plan(),weeks:0},{...plan(),weeks:1.5},{...plan(),entries:[]},{...plan(),entries:[entry(14)]},{...plan(),entries:[entry(),entry()]},{...plan(),entries:[{...entry(),duration:3000}]}])assert.throws(()=>normalizePlan(invalid));
 assert.throws(()=>schedulePlan(normalized,'2026-02-30'));assert.throws(()=>schedulePlan(normalized,'2200-12-31'));
});
test('cycle schedule creates independent snapshots, rejects duplicate deployment, and stays atomic',async()=>withServer(async api=>{
 const p=(await api('/plans','POST',plan())).data;assert.ok(p.id);
 assert.equal((await api(`/plans/${p.id}/schedule`,'POST',{startDate:'2200-12-31'})).status,400);assert.equal((await api('/activities')).data.length,0);
 const r=await api(`/plans/${p.id}/schedule`,'POST',{startDate:'2026-11-09'});assert.equal(r.status,201);assert.equal(r.data.activities.length,3);assert.equal(r.data.activities[2].date,'2026-11-16');
 await api(`/plans/${p.id}`,'PUT',{...p,name:'改名',entries:[{...entry(),name:'改变',duration:30}]});
 const original=(await api(`/activities/${r.data.activities[0].id}`)).data;assert.equal(original.name,'阈值训练');assert.equal(original.planOrigin.planName,'两周计划');assert.equal(original.duration,60);
 assert.equal((await api(`/plans/${p.id}/schedule`,'POST',{startDate:'2026-11-09'})).status,409);
 const count=(await api('/activities')).data.length;assert.equal((await api(`/plans/${p.id}/schedule`,'POST',{startDate:'2200-12-31'})).status,201); // one-step updated plan fits
 const before=(await api('/activities')).data.length;assert.equal((await api(`/plans/${p.id}/schedule`,'POST',{startDate:'2026-02-30'})).status,400);assert.equal((await api('/activities')).data.length,before);assert.equal(count,3);
}));
test('explicit actual linking enforces type and uniqueness without duplicating fitness load',async()=>withServer(async api=>{
 const p=(await api('/plans','POST',plan())).data;const batch=(await api(`/plans/${p.id}/schedule`,'POST',{startDate:'2026-11-09'})).data;
 const a=(await api('/activities','POST',{name:'实测',date:'2026-11-09',type:'Ride',duration:55,load:80})).data;
 const run=(await api('/activities','POST',{name:'跑步',date:'2026-11-09',type:'Run',duration:20,load:20})).data;
 assert.equal((await api('/planning/match','POST',{plannedId:batch.activities[0].id,actualId:run.id})).status,400);
 assert.equal((await api('/planning/match','POST',{plannedId:batch.activities[0].id,actualId:a.id})).status,200);
 assert.equal((await api('/planning/match','POST',{plannedId:batch.activities[1].id,actualId:a.id})).status,400);
 assert.equal((await api(`/activities/${batch.activities[0].id}`,'PUT',{completionId:run.id})).status,400);
 assert.equal((await api('/activities','POST',{...batch.activities[0],name:'伪造来源'})).status,400);
 assert.equal((await api(`/activities/${batch.activities[0].id}`,'PUT',{planOrigin:{...batch.activities[0].planOrigin,targetLoad:999}})).status,400);
 const b=(await api('/planning')).data.batches[0];assert.equal(b.completed,1);assert.equal(b.plannedDuration,180);assert.equal(b.actualDuration,55);assert.equal(b.plannedLoad,210);assert.equal(b.actualLoad,80);
 const fitness=(await api('/fitness?from=2026-11-09&to=2026-11-09')).data;assert.equal(fitness[0].load,100);
 assert.equal((await api(`/activities/${a.id}`,'PUT',{planned:true})).status,400);
 await api('/planning/match','POST',{plannedId:batch.activities[0].id,actualId:null});assert.equal((await api('/planning')).data.batches[0].completed,0);
}));
test('withdrawal retains completed and linked targets and all actual activity data',async()=>withServer(async api=>{
 const p=(await api('/plans','POST',plan())).data;const batch=(await api(`/plans/${p.id}/schedule`,'POST',{startDate:'2026-11-09'})).data;
 await api(`/activities/${batch.activities[0].id}`,'PUT',{planned:false,duration:65,load:75});
 const a=(await api('/activities','POST',{name:'导入实际',date:'2026-11-12',type:'Ride',duration:50,load:60})).data;await api('/planning/match','POST',{plannedId:batch.activities[1].id,actualId:a.id});
 const withdrawn=await api(`/planning/batches/${batch.batchId}`,'DELETE');assert.deepEqual(withdrawn.data,{removed:1,retained:2});assert.equal((await api('/activities')).data.length,3);
 await api(`/plans/${p.id}`,'DELETE');assert.equal((await api('/planning')).data.batches[0].completed,2);assert.equal((await api(`/activities/${a.id}`)).status,200);
 await api(`/activities/${a.id}`,'DELETE');const pending=(await api(`/activities/${batch.activities[1].id}`)).data;assert.equal(pending.completionId,undefined);
}));
test('planning backups retain snapshots and links; invalid restore is atomic; old backups clear new table',async()=>withServer(async api=>{
 const p=(await api('/plans','POST',plan())).data;const batch=(await api(`/plans/${p.id}/schedule`,'POST',{startDate:'2026-11-09'})).data;
 const a=(await api('/activities','POST',{name:'实测',date:'2026-11-09',type:'Ride',duration:50,load:60})).data;await api('/planning/match','POST',{plannedId:batch.activities[0].id,actualId:a.id});
 const backup=(await api('/backup')).data;assert.equal(backup.plans.length,1);assert.equal((await api('/restore','POST',backup)).status,200);assert.equal((await api('/planning')).data.batches[0].completed,1);
 const bad=structuredClone(backup);bad.activities=bad.activities.filter(x=>x.id!==a.id);assert.equal((await api('/restore','POST',bad)).status,400);assert.equal((await api('/activities')).data.length,4);
 const duplicate=structuredClone(backup);duplicate.plans.push(duplicate.plans[0]);assert.equal((await api('/restore','POST',duplicate)).status,400);
 const legacy={...backup,activities:[]};delete legacy.plans;assert.equal((await api('/restore','POST',legacy)).status,200);assert.deepEqual((await api('/plans')).data,[]);
}));
