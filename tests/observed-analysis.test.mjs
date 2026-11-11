import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeActivity} from '../src/analysis.mjs';
import {rideDetails} from '../src/ride-details.mjs';
const close=(a,b)=>assert.ok(Math.abs(a-b)<1e-8,`${a} != ${b}`);
const gapped=()=>({duration:90,streams:[...Array.from({length:1801},(_,time)=>({time,power:200,hr:140})),...Array.from({length:1801},(_,i)=>({time:3600+i,power:200,hr:154}))]});
test('observed NP IF TSS VI survive gaps without weakening whole-ride load gate',()=>{
 const a=gapped(),before=JSON.stringify(a),r=analyzeActivity(a,{ftp:250,weight:80}),m=r.displayMetrics;
 assert.equal(r.summary.tss,null);assert.equal(r.summary.normalizedPower,null);
 close(m.normalizedPower.value,200);close(m.intensityFactor.value,.8);close(m.tss.value,64);close(m.variabilityIndex.value,1);
 close(m.decoupling.value,100/11);close(m.normalizedPowerPerKg.value,2.5);close(m.efficiencyFactor.value,200/147);
 assert.equal(m.tss.scope,'仅有效记录');assert.match(m.tss.note,/不能代表整次活动/);assert.equal(JSON.stringify(a),before);
});
test('missing 30 second windows cannot be joined to create NP',()=>{
 const r=analyzeActivity({streams:[{time:0,power:200},{time:20,power:200},{time:100,power:200},{time:120,power:200}]},{ftp:250});
 assert.equal(r.displayMetrics.normalizedPower.value,null);assert.equal(r.displayMetrics.tss.value,null);
});
test('device metrics available without streams; corrections prevent stale device fallback',()=>{
 const a={duration:60,fitSummary:{normalizedPower:210,intensityFactor:.84,trainingStressScore:70}};
 const r=analyzeActivity(a,{ftp:250});assert.equal(r.displayMetrics.tss.value,70);assert.equal(r.displayMetrics.tss.scope,'设备记录');
 const b={...a,streams:[{time:0,power:200},{time:20,power:200}],powerCorrections:[{time:0,power:100}]};
 assert.equal(analyzeActivity(b,{ftp:250}).displayMetrics.normalizedPower.value,null);
});
test('zero power is measured; missing power is excluded from nonzero and zero shares',()=>{
 const r=analyzeActivity({streams:[{time:0,power:0},{time:10,power:300},{time:20},{time:30}]},{ftp:250});
 close(r.displayMetrics.zeroPowerPct.value,50);close(r.displayMetrics.nonzeroPower.value,300);close(r.displayMetrics.aboveFtpSeconds.value,10);
 assert.equal(r.displayMetrics.decoupling.value,null);assert.equal(r.displayMetrics.efficiencyFactor.value,null);
});
test('legacy generated timer summary restores rounded saved pause without modifying samples',()=>{
 const a={duration:100,notes:'FIT 经 Garmin 官方 SDK 解码，文件完整性及 CRC 已校验。设备计时 3600 秒',streams:[{time:0,timerActive:true},{time:6000,timerActive:false}]};
 const m=rideDetails(a).metrics;assert.equal(m.timerSeconds.value,3600);assert.equal(m.timerSeconds.source,'saved');assert.equal(m.pausedSeconds.value,2400);assert.equal(a.streams[0].timerActive,true);
 const device=rideDetails({...a,fitSummary:{timerSeconds:4000}}).metrics;assert.equal(device.timerSeconds.value,4000);assert.equal(device.pausedSeconds.value,2000);
});
test('arbitrary invalid or ambiguous notes do not become device timer metadata',()=>{
 const a={duration:100,streams:[{time:0,timerActive:true},{time:6000,timerActive:false}]};
 for(const notes of ['设备计时 3600 秒','FIT 经 Garmin 官方 SDK 解码，文件完整性及 CRC 已校验。设备计时 99999 秒','FIT 经 Garmin 官方 SDK 解码，文件完整性及 CRC 已校验。设备计时 3000 秒 设备计时 3600 秒'])assert.equal(rideDetails({...a,notes}).metrics.timerSeconds.value,6000);
});
test('stationary gap inference requires distance evidence and remains separate from pause',()=>{
 const a={duration:10,streams:[{time:0,distance:0,timerActive:true},{time:300,distance:10,timerActive:true},{time:600,distance:2000,timerActive:false}]};
 const m=rideDetails(a).metrics;assert.equal(m.estimatedPauseSeconds.value,300);assert.equal(m.estimatedPauseSeconds.source,'estimated');assert.equal(m.pausedSeconds.value,0);
 assert.equal(rideDetails({...a,streams:a.streams.map(({distance,...s})=>s)}).metrics.estimatedPauseSeconds.value,null);
});
