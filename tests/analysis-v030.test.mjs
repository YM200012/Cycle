import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeActivity} from '../src/analysis.mjs';
const constant=(seconds,power=200)=>({date:'2026-05-01',streams:Array.from({length:seconds+1},(_,time)=>({time,power,hr:140}))});
const settings={ftp:300,ftpHistory:[{date:'2026-01-01',ftp:200},{date:'2026-06-01',ftp:250}]};
test('activity-date FTP drives IF, TSS, automatic intervals and zone classification',()=>{
 const data=analyzeActivity(constant(3600),settings);
 assert.equal(data.summary.ftp,200);assert.equal(data.summary.ftpSource,'history');assert.equal(data.summary.ftpEffectiveDate,'2026-01-01');
 assert.equal(data.summary.intensityFactor,1);assert.equal(data.summary.tss,100);assert.equal(data.intervals.length,1);assert.equal(data.intervals[0].zone,'Z4');
 assert.equal(data.powerZones[3].seconds,3600);
 const changed=analyzeActivity(constant(3600),{...settings,ftp:400});assert.equal(changed.summary.tss,100);
});
test('configurable effort minimum, threshold and recovery affect only automatic ranges',()=>{
 const a=constant(100,200);for(const r of a.streams)if(r.time>=40&&r.time<50)r.power=100;
 assert.equal(analyzeActivity(a,{ftp:200,effortThresholdPct:110}).intervals.length,0);
 assert.equal(analyzeActivity(a,{ftp:200,effortMinSeconds:95}).intervals.length,0);
 assert.equal(analyzeActivity(a,{ftp:200,effortMinSeconds:30,effortRecoverySeconds:0}).intervals.length,2);
 a.segments=[{start:0,end:100,label:'manual'}];assert.equal(analyzeActivity(a,{ftp:200,effortThresholdPct:300}).intervals.length,1);
});
test('histograms integrate fractional duration, zero and corrections without filling gaps or pauses',()=>{
 const a={streams:[{time:0,power:0,hr:100},{time:.5,power:50,hr:120},{time:2,power:150,hr:140,timerActive:false},{time:3,power:100,hr:130},{time:40,power:1000,hr:200},{time:41}],powerCorrections:[{time:40,power:150}]};
 const d=analyzeActivity(a,{ftp:200}).distributions;
 assert.equal(d.power.reduce((s,b)=>s+b.seconds,0),3);
 assert.equal(d.hr.reduce((s,b)=>s+b.seconds,0),3);
 assert.equal(d.power[0].seconds,.5);assert.equal(d.power[1].seconds,1.5);assert.equal(d.power[3].seconds,1);
 assert.equal(d.power.at(-1).seconds,0);assert.equal(a.streams[4].power,1000);
});
