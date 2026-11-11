import test from 'node:test';
import assert from 'node:assert/strict';
import {priorAwareEstimates} from '../src/performance-estimates.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startServer} from '../src/server.mjs';
const point=(seconds,watts)=>({seconds,watts,start:0,end:seconds});
const estimate=(curve,opts={})=>priorAwareEstimates(curve,70,{baseline:175,currentFtp:175,...opts});
test('easy and incomplete rides retain 175 W explicitly as prior, never infer a low personal FTP',()=>{
 for(const curve of [[],[point(300,130)],[point(480,140),point(1200,120)],[point(3600,100)]]){const e=estimate(curve);assert.equal(e.ftp.value,175);assert.equal(e.ftp.method,'prior');assert.equal(e.updateSuggestion,null);}
 assert.equal(estimate([point(1200,120)]).selectedReference.value,114);
});
test('upward suggestions preserve observed evidence and assumptions without automatically changing prior',()=>{
 const e=estimate([point(480,210),point(1200,200)]);assert.equal(e.ftp.value,175);assert.equal(e.updateSuggestion.value,190);assert.equal(e.updateSuggestion.level,'conditional');assert.equal(e.updateSuggestion.effort.seconds,1200);assert.match(e.updateSuggestion.message,/换算依赖/);
 const hour=estimate([point(3600,190)]);assert.equal(hour.updateSuggestion.level,'sustained');assert.equal(hour.updateSuggestion.value,190);
 assert.equal(estimate([point(1200,186)]).updateSuggestion,null);const bad=estimate([point(1200,2000)]);assert.equal(bad.updateSuggestion,null);assert.ok(bad.powerMeterWarning);
});
test('short and CP extrapolations remain weak hints; manual formula selection cannot lower prior',()=>{
 const e=estimate([point(480,240)]);assert.equal(e.updateSuggestion.level,'weak');assert.equal(e.updateSuggestion.value,216);assert.match(e.updateSuggestion.message,/不能确认/);
 const cp=estimate([180,300,480,600].map(t=>point(t,200+18000/t)));assert.equal(cp.updateSuggestion.level,'weak');
 const manual=estimate([point(480,140)],{method:'p8'});assert.equal(manual.ftp.value,175);assert.equal(manual.selectedReference.value,126);assert.equal(manual.updateSuggestion,null);
 assert.equal(estimate([point(480,140)],{method:'p60'}).ftp.value,175);assert.equal(estimate([point(480,140)],{method:'p60'}).selectedReference,null);
});
test('historical prior and current FTP remain distinct and do not suggest downgrading current FTP',()=>{
 const e=estimate([point(1200,174)],{baseline:150,baselineSource:'history',baselineDate:'2026-01-01'});assert.equal(e.ftp.value,150);assert.equal(e.currentFtp,175);assert.equal(e.updateSuggestion,null);assert.equal(e.baselineSource,'history');
});
test('API uses effective historical FTP, corrected samples and creates no settings/history/load writes',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'cycle-ftp-prior-')),server=await startServer({dataDir:dir});const api=async(path,method='GET',body)=>{const r=await fetch(server.url+'/api'+path,{method,...(body===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(body)})});return {status:r.status,data:await r.json()};};
 try{
 await api('/settings','PUT',{ftp:175,ftpHistory:[{date:'2026-01-01',ftp:150},{date:'2026-11-01',ftp:175}]});const settings=(await api('/settings')).data;
 const make=(date,power)=>({name:'Prior test',type:'Ride',date,duration:20,load:12,streams:Array.from({length:1201},(_,time)=>({time,power}))});
 const easy=(await api('/activities','POST',make('2026-11-10',120))).data;assert.equal((await api(`/activities/${easy.id}/analysis`)).data.estimates.ftp.value,175);
 const old=(await api('/activities','POST',make('2026-02-01',174))).data;const oldEstimate=(await api(`/activities/${old.id}/analysis`)).data.estimates;assert.equal(oldEstimate.ftp.value,150);assert.equal(oldEstimate.currentFtp,175);assert.equal(oldEstimate.updateSuggestion,null);
 const hard=(await api('/activities','POST',make('2026-11-10',200))).data;assert.equal((await api(`/activities/${hard.id}/analysis`)).data.estimates.updateSuggestion.value,190);
 await api(`/activities/${hard.id}/power-corrections`,'PUT',{corrections:[{time:600,power:null}]});const updated=(await api(`/activities/${hard.id}/analysis`)).data.estimates;assert.equal(updated.methods.find(m=>m.id==='p20').value,null);assert.notEqual(updated.updateSuggestion?.level,'conditional');
 assert.deepEqual((await api('/settings')).data,settings);assert.equal((await api(`/activities/${hard.id}`)).data.load,12);
 }finally{await server.close();await rm(dir,{recursive:true,force:true});}
});
