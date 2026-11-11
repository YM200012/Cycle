import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {normalizeGear,gearUsage,normalizeGoal,goalOverview} from '../src/workspace.mjs';import {startServer} from '../src/server.mjs';
async function withServer(fn){const dir=await mkdtemp(join(tmpdir(),'cycle-workspace-')),server=await startServer({dataDir:dir});const api=async(path,method='GET',body)=>{const r=await fetch(server.url+'/api'+path,{method,headers:{'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,data:await r.json()};};try{await fn(api);}finally{await server.close();await rm(dir,{recursive:true,force:true});}}
const ride=(extra={})=>({name:'实际骑行',type:'Ride',date:'2026-11-09',duration:60,distance:40,load:50,...extra});
const gear=()=>({name:'公路车',type:'Ride',initialDistance:100,serviceEveryKm:50});
const goal=extra=>({name:'目标比赛',date:'2026-11-15',type:'Ride',priority:'A',targetDistance:100,targetDuration:180,...extra});
test('workspace models validate dates, types, bounds and optional goals without altering inputs',()=>{
 const g=normalizeGear(gear(),'g');assert.equal(g.active,true);assert.deepEqual(g.services,[]);assert.equal(g.servicedAtKm,0);
 const goals=normalizeGoal(goal(),'goal');assert.equal(goalOverview(goals,[],'2026-11-09').daysUntil,6);assert.equal(goalOverview(goals,[],'2026-11-15').status,'today');assert.equal(goalOverview(goals,[],'2026-11-16').status,'past');
 for(const invalid of [{...gear(),type:'Note'},{...gear(),initialDistance:-1},{...gear(),serviceEveryKm:0},{...gear(),active:'false'},{...gear(),services:null}])assert.throws(()=>normalizeGear(invalid));
 for(const invalid of [goal({date:'2026-02-30'}),goal({priority:'D'}),goal({targetDuration:3000}),goal({targetDistance:-1})])assert.throws(()=>normalizeGoal(invalid));
 const input=[ride({id:'a',gearId:'g'}),ride({id:'p',gearId:'g',planned:true}),ride({id:'b',gearId:'other'})],before=structuredClone(input);assert.deepEqual(gearUsage(g,input),{distance:140,duration:60,count:1,sinceService:140,remainingKm:-90});assert.deepEqual(input,before);
});
test('gear assignment checks type and active state, counts completed usage, and service records current odometer',async()=>withServer(async api=>{
 const g=(await api('/gear','POST',gear())).data;assert.equal(g.usage.distance,100);
 const a=(await api('/activities','POST',ride({gearId:g.id}))).data;assert.ok(a.id);
 assert.equal((await api('/activities','POST',ride({gearId:g.id,type:'Run'}))).status,400);
 await api('/activities','POST',ride({name:'计划',gearId:g.id,planned:true,distance:200}));
 let fetched=(await api(`/gear/${g.id}`)).data;assert.equal(fetched.usage.count,1);assert.equal(fetched.usage.distance,140);assert.equal(fetched.usage.duration,60);
 const serviced=await api(`/gear/${g.id}/service`,'POST',{date:'2026-11-09',notes:'清洁链条'});assert.equal(serviced.status,200);assert.equal(serviced.data.servicedAtKm,140);assert.equal(serviced.data.services[0].odometer,140);assert.equal(serviced.data.usage.remainingKm,50);
 assert.equal((await api(`/gear/${g.id}`,'PUT',{services:[]})).status,400);assert.equal((await api(`/gear/${g.id}`,'PUT',{servicedAtKm:0})).status,400);
 await api(`/gear/${g.id}`,'PUT',{active:false});assert.equal((await api('/activities','POST',ride({gearId:g.id}))).status,400);assert.equal((await api(`/activities/${a.id}`,'PUT',{notes:'保留停用器材'})).status,200);
 assert.equal((await api(`/gear/${g.id}`,'PUT',{type:'Run'})).status,400);assert.equal((await api('/workouts','POST',{name:'模板',gearId:g.id})).status,400);
 await api(`/gear/${g.id}`,'DELETE');assert.equal((await api(`/activities/${a.id}`)).data.gearId,undefined);assert.equal((await api('/activities')).data.length,2);
}));
test('goals link only unique completed activities of matching type and protect links during edits',async()=>withServer(async api=>{
 const a=(await api('/activities','POST',ride())).data,p=(await api('/activities','POST',ride({planned:true}))).data;
 assert.equal((await api('/goals','POST',goal({activityId:p.id}))).status,400);assert.equal((await api('/goals','POST',goal({activityId:a.id,type:'Run'}))).status,400);
 const g=(await api('/goals','POST',goal({activityId:a.id}))).data;assert.equal(g.status,'recorded');assert.equal(g.actual.id,a.id);
 assert.equal((await api('/goals','POST',goal({name:'重复关联',activityId:a.id}))).status,400);assert.equal((await api(`/activities/${a.id}`,'PUT',{type:'Run'})).status,400);assert.equal((await api(`/activities/${a.id}`,'PUT',{planned:true})).status,400);
 const list=(await api('/goals?asOf=2026-11-09')).data;assert.equal(list[0].daysUntil,6);assert.equal((await api('/goals?asOf=2026-02-30')).status,400);
 const fitness=(await api('/fitness?from=2026-11-09&to=2026-11-09')).data;assert.equal(fitness[0].load,50);
 await api(`/goals/${g.id}`,'PUT',{activityId:null});assert.equal((await api(`/goals/${g.id}?asOf=2026-11-09`)).data.status,'upcoming');
 await api(`/goals/${g.id}`,'PUT',{activityId:a.id});await api(`/activities/${a.id}`,'DELETE');const remaining=(await api(`/goals/${g.id}`)).data;assert.equal(remaining.activityId,undefined);assert.equal(remaining.actual,null);
}));
test('workspace backups preserve inactive references and services; invalid restoration is atomic; old backups clear new tables',async()=>withServer(async api=>{
 const g=(await api('/gear','POST',gear())).data,a=(await api('/activities','POST',ride({gearId:g.id}))).data;
 await api(`/gear/${g.id}/service`,'POST',{date:'2026-11-09',notes:'检查'});await api(`/gear/${g.id}`,'PUT',{active:false});const target=(await api('/goals','POST',goal({activityId:a.id}))).data;
 const backup=(await api('/backup')).data;assert.equal(backup.gear[0].services.length,1);assert.equal(backup.goals[0].activityId,a.id);assert.equal((await api('/restore','POST',backup)).status,200);assert.equal((await api(`/activities/${a.id}`)).data.gearId,g.id);assert.equal((await api(`/goals/${target.id}`)).data.actual.id,a.id);
 for(const mutate of [b=>b.gear=null,b=>b.goals=null,b=>b.gear=[],b=>b.activities=[],b=>b.goals.push(b.goals[0]),b=>b.gear.push(b.gear[0])]){const bad=structuredClone(backup);mutate(bad);assert.equal((await api('/restore','POST',bad)).status,400);assert.equal((await api('/gear')).data.length,1);assert.equal((await api('/goals')).data.length,1);}
 const old={...backup,activities:backup.activities.map(a=>{const copy={...a};delete copy.gearId;return copy;})};delete old.gear;delete old.goals;assert.equal((await api('/restore','POST',old)).status,200);assert.deepEqual((await api('/gear')).data,[]);assert.deepEqual((await api('/goals')).data,[]);assert.equal((await api('/activities')).data.length,1);
}));
test('deleting demos clears goal references without deleting user goals or gear',async()=>withServer(async api=>{
 const g=(await api('/gear','POST',gear())).data,a=(await api('/activities','POST',ride({gearId:g.id,demo:true}))).data;const target=(await api('/goals','POST',goal({activityId:a.id}))).data;
 await api('/demo','DELETE');assert.equal((await api('/activities')).data.length,0);assert.equal((await api('/gear')).data[0].usage.distance,100);assert.equal((await api(`/goals/${target.id}`)).data.activityId,undefined);
}));
