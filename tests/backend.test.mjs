import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server.mjs';
import { fitness, defaults, powerAnalysis } from '../src/metrics.mjs';
import { importFile } from '../src/import.mjs';

test('fitness excludes planned load; CTL uses configured exponential constant and TSB prior-day values',()=>{
  const values=fitness([{date:'2026-11-01',load:100,planned:false},{date:'2026-11-02',load:1000,planned:true}],defaults,'2026-11-01','2026-11-02');
  const expected=100*(1-Math.exp(-1/42));
  assert.ok(Math.abs(values[0].ctl-expected)<1e-10);
  assert.equal(values[0].tsb,0); assert.equal(values[1].load,0);
  assert.ok(values[1].ctl < values[0].ctl);
  assert.ok(values[1].tsb<0);
});
test('power windows preserve real gaps and do not invent curve from average power',()=>{
  const a={id:'a',power:300,streams:[{time:0,power:100},{time:5,power:200},{time:10,power:300},{time:15,power:0}]};
  const result=powerAnalysis([a,{id:'b',power:999}],defaults);
  assert.equal(result.curve.find(p=>p.seconds===5).watts,300);
  assert.equal(result.curve.find(p=>p.seconds===10).watts,250);
  assert.equal(result.curve.find(p=>p.seconds===15).watts,200);
  assert.equal(result.zones.reduce((n,z)=>n+z.seconds,0),15);
  const gaps=powerAnalysis([{id:'c',streams:[{time:0,power:500},{time:60,power:500},{time:65,power:100}]}],defaults);
  assert.equal(gaps.curve.find(p=>p.seconds===5).watts,500);
  assert.equal(gaps.curve.some(p=>p.seconds===10),false);
  assert.deepEqual(powerAnalysis([{power:300}],defaults).curve,[]);
});
test('GPX imports recorded power, duration and geographic distance; rejects external XML entities',()=>{
  const text='<gpx><trk><name>Road &amp; Hills</name><type>cycling</type><trkseg><trkpt lat="31" lon="121"><time>2026-11-01T00:00:00Z</time><extensions><power>150</power><gpxtpx:hr>130</gpxtpx:hr></extensions></trkpt><trkpt lat="31.001" lon="121"><time>2026-11-01T00:01:00Z</time><extensions><power>200</power></extensions></trkpt></trkseg></trk></gpx>';
  const a=importFile('ride.gpx',Buffer.from(text),defaults)[0];
  assert.equal(a.name,'Road & Hills');assert.equal(a.duration,1);assert.ok(a.distance>.1&&a.distance<.12);assert.equal(a.streams[0].power,150);assert.equal(a.hr,130);
  assert.throws(()=>importFile('a.gpx',Buffer.from('<!DOCTYPE foo>'+text),defaults),/外部实体/);
});
test('TCX reads heart rate extension and multiple activities',()=>{
  const points='<Track><Trackpoint><Time>2026-11-01T00:00:00Z</Time><HeartRateBpm><Value>120</Value></HeartRateBpm><DistanceMeters>0</DistanceMeters><Extensions><ns3:TPX><ns3:Watts>180</ns3:Watts></ns3:TPX></Extensions></Trackpoint><Trackpoint><Time>2026-11-01T00:01:00Z</Time><DistanceMeters>200</DistanceMeters></Trackpoint></Track>';
  const rows=importFile('run.tcx',Buffer.from(`<TrainingCenterDatabase><Activities><Activity Sport="Running">${points}</Activity><Activity Sport="Biking">${points}</Activity></Activities></TrainingCenterDatabase>`),defaults);
  assert.equal(rows.length,2);assert.equal(rows[0].type,'Run');assert.equal(rows[0].hr,120);assert.equal(rows[0].power,180);assert.equal(rows[0].distance,.2);
});
test('CRUD persistence, atomic import/restore, duplicates and origin protection',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'cycle-test-'));let server=await startServer({dataDir:dir});
  const api=async(path,method='GET',data,headers={})=>{ const response=await fetch(server.url+path,{method,headers:{'content-type':'application/json',...headers},...(data!==undefined?{body:JSON.stringify(data)}:{})});return {status:response.status,data:await response.json()}; };
  try {
    assert.deepEqual((await api('/api/activities')).data,[]);
    let r=await api('/api/activities','POST',{name:'Ride',date:'2026-11-01',duration:60,load:50});assert.equal(r.status,201);const id=r.data.id;
    r=await api('/api/activities/'+id,'PUT',{name:'Changed'});assert.equal(r.data.duration,60);
    assert.equal((await api('/api/activities','POST',{name:'Bad',date:'2026-02-30'})).status,400);
    assert.equal((await api('/api/settings','PUT',{ftp:0})).status,400);
    assert.equal((await api('/api/settings','PUT',{ftp:275},{origin:'https://evil.example'})).status,403);
    assert.equal((await api('/api/settings','PUT',{ftp:275})).status,200);
    const csv='date,name,type,duration,distance,load,power,hr\n2026-11-02,"Ride, hills",Ride,90,40,70,180,140\n';
    const payload={filename:'ride.csv',content:Buffer.from(csv).toString('base64')};
    assert.equal((await api('/api/import','POST',payload)).status,201);
    assert.equal((await api('/api/import','POST',payload)).status,409);
    const invalid='date,name,duration\n2026-11-03,Good,10\n2026-02-30,Bad,10';
    assert.equal((await api('/api/import','POST',{filename:'bad.csv',content:Buffer.from(invalid).toString('base64')})).status,400);
    assert.equal((await api('/api/activities')).data.length,2);
    const backup=(await api('/api/backup')).data;
    assert.equal((await api('/api/restore','POST',{...backup,activities:[{name:'Bad',date:'n/a'}]})).status,400);
    assert.equal((await api('/api/activities')).data.length,2);
    await api('/api/activities/'+id,'DELETE');assert.equal((await api('/api/activities')).data.length,1);
    assert.equal((await api('/api/restore','POST',backup)).status,200);
    assert.equal((await api('/api/activities')).data.length,2);
    await api('/api/wellness','POST',{date:'2026-11-01',sleep:8,weight:70});
    assert.equal((await api('/api/wellness')).data[0].sleep,8);
    await api('/api/demo','POST',{});
    assert.ok((await api('/api/activities')).data.length>2);
    assert.equal((await api('/api/demo','DELETE')).status,200);
    assert.equal((await api('/api/activities')).data.length,2);
    assert.equal((await api('/api/workouts')).data.length,0);
    await server.close();server=await startServer({dataDir:dir});
    assert.equal((await api('/api/settings')).data.ftp,275);
    assert.equal((await api('/api/activities')).data.length,2);
  } finally {await server.close();await rm(dir,{recursive:true,force:true});}
});
