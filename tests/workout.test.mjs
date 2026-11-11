import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {parseWorkout,formatWorkout,normalizeIntervals,workoutLoad,workoutZwo} from '../src/workout.mjs';import {startServer} from '../src/server.mjs';
const close=(a,b)=>assert.ok(Math.abs(a-b)<1e-9,`${a} != ${b}`);
test('workout text expands repeat groups, seconds and ramps while retaining labels',()=>{
 const p=parseWorkout('# example\n10m @ 50-75% | 热身\n4x {\n4m @ 100 | 努力\n90s @ 55\n}\n5m @ 60-40% | 放松');
 assert.equal(p.intervals.length,10);close(p.duration,37);assert.equal(p.intervals[0].powerEnd,75);assert.equal(p.intervals[1].label,'努力');assert.equal(p.intervals[2].duration,1.5);assert.equal(p.intervals.at(-1).powerEnd,40);
 assert.equal(parseWorkout('2x {\n2x {\n1:30 @ 100\n}\n}').intervals.length,4);
 close(parseWorkout('1:02:03 @ 60').duration,62.05);assert.equal(parseWorkout('10 @ 60').duration,10);
});
test('ramp reference load uses linear-power square integral and constant steps retain legacy calculation',()=>{
 close(workoutLoad([{duration:60,power:50,powerEnd:100}]),100*(.25+.5+1)/3);
 close(workoutLoad([{duration:60,power:100,powerEnd:50}]),100*(.25+.5+1)/3);
 close(workoutLoad([{duration:60,power:100}]),100);assert.equal(parseWorkout('60m @ 50-100').load,58);
});
test('formatter preserves fractional seconds and complete ramp targets for re-editing legacy steps',()=>{
 const p=parseWorkout('1.234m @ 50.25-75.5 | ramp\n1.2s @ 0');const formatted=formatWorkout(p.intervals),again=parseWorkout(formatted);
 assert.equal(again.intervals.length,2);p.intervals.forEach((step,i)=>{close(again.intervals[i].duration,step.duration);assert.equal(again.intervals[i].power,step.power);assert.equal(again.intervals[i].powerEnd,step.powerEnd);});
 const legacy=[{duration:.01,power:0,label:'old'}];assert.deepEqual(normalizeIntervals(legacy),legacy);assert.deepEqual(parseWorkout(formatWorkout(legacy)).intervals,legacy);
});
test('workout parser reports line errors and bounds expansions, nesting, durations and targets',()=>{
 for(const text of ['','2x {\n}','2x {\n1m @ 50','}\n1m @ 50','51x {\n1m @ 50\n}','50x {\n50x {\n1s @ 50\n}\n}','1x {\n1x {\n1x {\n1x {\n1x {\n1s @ 50\n}\n}\n}\n}\n}','.5s @ 50','1:60 @ 50','1m @ 501','1m @ 50-501','2160m @ 50\n1m @ 50','2160m @ 500'])assert.throws(()=>parseWorkout(text),/第 \d+ 行/);
 assert.throws(()=>parseWorkout('x'.repeat(30001)),/30000/);assert.equal(parseWorkout('4x {\n1s @ 50\n}').intervals.length,4);
 assert.throws(()=>normalizeIntervals([{duration:1,power:50,powerEnd:NaN}]),/渐变结束/);assert.throws(()=>normalizeIntervals([{duration:1,power:50,label:'x'.repeat(121)}]),/120/);assert.throws(()=>normalizeIntervals([{duration:1,power:50,label:'a\nb'}]),/单行/);
});
test('ZWO escapes XML, preserves ramp direction and emits FTP ratios with seconds',()=>{
 const xml=workoutZwo({type:'Ride',name:'A & B <x>',description:'"quote"',intervals:[{duration:1.5,power:50,powerEnd:100,label:'高 "&"'},{duration:2,power:100},{duration:1,power:75,powerEnd:40}]});
 assert.match(xml,/<name>A &amp; B &lt;x&gt;<\/name>/);assert.match(xml,/<Warmup Duration="90" PowerLow="0.5" PowerHigh="1">/);assert.match(xml,/<SteadyState Duration="120" Power="1">/);assert.match(xml,/<Cooldown Duration="60" PowerLow="0.75" PowerHigh="0.4">/);assert.match(xml,/message="高 &quot;&amp;&quot;"/);assert.throws(()=>workoutZwo({type:'Run',intervals:[{duration:1,power:50}]}),/仅支持/);assert.throws(()=>workoutZwo({type:'Ride',intervals:[]}),/没有可导出/);assert.equal(workoutZwo({type:'Ride',name:'a\u0000b',intervals:[{duration:1,power:50}]}).includes('\u0000'),false);
});
test('workout API derives authoritative text values, exports ZWO and preserves ramps through planning and backups',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'cycle-workout-')),server=await startServer({dataDir:dir});
 const api=async(path,method='GET',body)=>{const r=await fetch(server.url+'/api'+path,{method,headers:{'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,data:await r.json()};};
 try{
  const text='10m @ 50-75% | 热身\n2x {\n90s @ 105\n30s @ 55\n}';const parsed=parseWorkout(text);
  const r=await api('/workouts','POST',{name:'Ramps & repeats',type:'Ride',workoutText:text,duration:999,load:999,intervals:[{duration:1,power:1}]});assert.equal(r.status,201);const w=r.data;close(w.duration,14);assert.equal(w.load,parsed.load);assert.deepEqual(w.intervals,parsed.intervals);assert.equal(w.workoutText,text);
  const zwo=await fetch(server.url+`/api/workouts/${w.id}/export.zwo`);assert.equal(zwo.status,200);assert.match(zwo.headers.get('content-type'),/xml/);assert.match(zwo.headers.get('content-disposition'),/attachment/);assert.match(await zwo.text(),/PowerLow="0.5" PowerHigh="0.75"/);
  const p=(await api('/plans','POST',{name:'Ramps cycle',weeks:1,entries:[{id:'e',day:0,name:w.name,type:w.type,duration:w.duration,load:w.load,intervals:w.intervals}]})).data;
  const batch=(await api(`/plans/${p.id}/schedule`,'POST',{startDate:'2026-11-09'})).data;assert.deepEqual(batch.activities[0].intervals,w.intervals);
  const backup=(await api('/backup')).data;assert.equal((await api('/restore','POST',backup)).status,200);assert.deepEqual((await api(`/workouts/${w.id}`)).data.intervals,w.intervals);assert.equal((await api(`/workouts/${w.id}`)).data.workoutText,text);assert.deepEqual((await api(`/plans/${p.id}`)).data.entries[0].intervals,w.intervals);
  assert.equal((await api(`/workouts/${w.id}`,'PUT',{workoutText:'2x {\n1m @ 50'})).status,400);assert.equal((await api(`/workouts/${w.id}`)).data.workoutText,text);
  const old=await api('/workouts','POST',{name:'Legacy',type:'Ride',duration:20,load:10,intervals:[{duration:20,power:60}]});assert.equal(old.status,201);assert.equal(old.data.workoutText,undefined);
  const module=await fetch(server.url+'/workout.mjs');assert.match(module.headers.get('content-type'),/javascript/);assert.equal(module.status,200);
 }finally{await server.close();await rm(dir,{recursive:true,force:true});}
});
