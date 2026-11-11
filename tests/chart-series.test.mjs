import test from 'node:test';
import assert from 'node:assert/strict';
import {chartSeries} from '../src/chart-series.mjs';
test('high-detail reduction preserves a one-second sprint and trough at real times',()=>{
 const rows=Array.from({length:18001},(_,time)=>({time,power:time===8137?1200:time===8138?0:200})),before=structuredClone(rows);
 const s=chartSeries(rows,'power');assert.ok(s.displayCount>450);assert.ok(s.displayCount<=3604);
 assert.equal(s.values[s.times.indexOf(8137)],1200);assert.equal(s.values[s.times.indexOf(8138)],0);
 assert.equal(s.times[0],0);assert.equal(s.times.at(-1),18000);assert.deepEqual(rows,before);
});
test('native sampling retains fractional timestamps, conversion and chosen range',()=>{
 const rows=Array.from({length:100},(_,i)=>({time:i*.2,speed:i/10}));
 const s=chartSeries(rows,'speed',{start:2,stop:4,budget:Infinity,factor:3.6});assert.equal(s.displayCount,11);assert.equal(s.times[1],2.2);assert.equal(s.values[0],3.6);
});
test('gaps missing values and pauses always split paths, even within a single display bucket',()=>{
 const rows=[{time:0,power:100},{time:1,power:900},{time:2},{time:3,power:200},{time:4,power:100,timerActive:false},{time:5,power:300},{time:100,power:400}];
 const s=chartSeries(rows,'power',{budget:4});assert.equal(s.values.filter(x=>x===null).length,3);assert.deepEqual(s.values.filter(x=>x!==null),[100,900,200,300,400]);
});
test('original sampling supports long records without argument stack overflow',()=>{
 const rows=Array.from({length:129601},(_,time)=>({time,power:200}));assert.equal(chartSeries(rows,'power',{budget:Infinity}).displayCount,129601);
});

test('cadence uses lower-density sampling means while raw mode remains unchanged',()=>{
 const rows=Array.from({length:3601},(_,time)=>({time,cadence:time%2?120:60,power:time%2?300:100}));
 const cadence=chartSeries(rows,'cadence',{budget:1200}),power=chartSeries(rows,'power',{budget:1200});assert.ok(cadence.displayCount<power.displayCount/2);assert.ok(cadence.values.filter(Number.isFinite).slice(0,-1).every(v=>v>=84&&v<=96));
 assert.equal(chartSeries(rows,'cadence',{budget:Infinity}).displayCount,3601);
 const zoom=chartSeries(rows,'power',{start:100,stop:160,budget:1200});assert.equal(zoom.displayCount,61);assert.ok(zoom.displayCount/60>power.displayCount/3600);
});
