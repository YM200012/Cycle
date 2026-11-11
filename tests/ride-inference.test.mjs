import test from 'node:test';
import assert from 'node:assert/strict';
import {rideDetails,rideSpeedStreams} from '../src/ride-details.mjs';
const close=(a,b,tolerance=1e-8)=>assert.ok(Math.abs(a-b)<tolerance,`${a} differs from ${b}`);

test('GPS fallback yields SI speed and observed distance, retains provenance and leaves input untouched',()=>{
  const activity={duration:10/60,distance:0,streams:[{time:0,lat:0,lon:0},{time:10,lat:0,lon:.001}]},before=structuredClone(activity);
  const rows=rideSpeedStreams(activity);close(rows[0].speed,11.119508023353292);assert.equal(rows[0].speedSource,'gps');
  assert.equal(rows[1].speed,undefined);assert.equal(rideSpeedStreams({streams:rows})[0].speedSource,'gps');
  const result=rideDetails(activity);close(result.metrics.distance.value,.11119508023353292);close(result.metrics.avgSpeed.value,40.03022888407185);
  assert.equal(result.metrics.distance.source,'derived');assert.equal(result.speedSource,'gps');assert.match(result.metrics.avgSpeed.note,/GPS/);assert.deepEqual(activity,before);
});

test('GPS cannot bridge a distance reset, timer stop, recording gap, bad coordinate or implausible jump',()=>{
  for(const rows of [
    [{time:0,lat:0,lon:0,distance:200},{time:10,lat:0,lon:.001,distance:100}],
    [{time:0,lat:0,lon:0},{time:10,lat:0,lon:.001,timerActive:false}],
    [{time:0,lat:0,lon:0},{time:40,lat:0,lon:.001}],
    [{time:0,lat:91,lon:0},{time:10,lat:0,lon:.001}],
    [{time:0,lat:0,lon:0},{time:1,lat:0,lon:1}]
  ])assert.equal(rideSpeedStreams({streams:rows})[0].speed,undefined);
  const boundary=rideSpeedStreams({streams:[{time:0,distance:0,timerActive:true},{time:10,distance:50,timerActive:false}]});assert.equal(boundary[0].speed,5);assert.equal(boundary[1].speed,undefined);
  const rows=rideSpeedStreams({streams:[{time:0,distance:0,lat:0,lon:0},{time:10,distance:50,lat:0,lon:.001}]});assert.equal(rows[0].speed,5);assert.equal(rows[0].speedSource,'distance');
});

test('power integration supplies mechanical work and explicitly assumed calorie range, with corrections applied',()=>{
  const activity={duration:.5,streams:[{time:0,power:200,speed:10,hr:150,cadence:90,timerActive:true},{time:10,power:200,speed:10,hr:150,cadence:90,timerActive:true},{time:30,power:200,speed:10,hr:150,cadence:90,timerActive:true}]};
  const result=rideDetails(activity,{weight:80,maxHr:200});
  assert.equal(result.metrics.workKj.value,6);assert.equal(result.metrics.workKj.source,'samples');close(result.metrics.calories.value,6/4.184/.24);
  close(result.metrics.caloriesLow.value,6/4.184/.25);close(result.metrics.caloriesHigh.value,6/4.184/.20);assert.equal(result.metrics.calories.source,'estimated');assert.match(result.metrics.calories.note,/24%/);
  assert.equal(result.metrics.powerCoveragePct.value,100);assert.equal(result.metrics.powerPerKg.value,2.5);assert.equal(result.metrics.hrPercentMax.value,75);assert.equal(result.metrics.cadenceRevolutions.value,45);close(result.metrics.avgTorqueNm.value,200/(90*2*Math.PI/60));
  const corrected=rideDetails({...activity,powerCorrections:[{time:0,power:100}]});assert.equal(corrected.metrics.workKj.value,5);close(corrected.metrics.calories.value,5/4.184/.24);
  const device=rideDetails({...activity,fitSummary:{workKj:9,calories:123}});assert.equal(device.metrics.workKj.value,9);assert.equal(device.metrics.calories.value,123);assert.equal(device.metrics.calories.source,'device');assert.equal(device.metrics.caloriesLow.value,null);
});

test('timer state may span recording gaps but physical measurements and whole-ride calorie estimates never do',()=>{
  const r=rideDetails({duration:2,streams:[{time:0,power:200,timerActive:true},{time:10,power:900,timerActive:false},{time:40,power:200,timerActive:true},{time:50,power:200,timerActive:true},{time:110,power:200,timerActive:true}]});
  assert.equal(r.metrics.timerSeconds.value,90);assert.equal(r.metrics.pausedSeconds.value,30);assert.equal(r.metrics.observedSeconds.value,20);assert.equal(r.metrics.workKj.value,4);close(r.metrics.powerCoveragePct.value,20/90*100);
  assert.equal(r.metrics.calories.value,null);assert.match(r.metrics.calories.missingReason,/95%/);assert.equal(r.metrics.maxPower.value,200);
  close(r.metrics.observedCalories.value,4/4.184/.24);assert.equal(r.metrics.observedCalories.source,'estimated');
  close(r.metrics.observedCaloriesLow.value,4/4.184/.25);close(r.metrics.observedCaloriesHigh.value,4/4.184/.20);
  assert.match(r.metrics.observedCalories.note,/22.22%/);assert.match(r.metrics.observedCalories.note,/不是整次活动热量/);assert.match(r.metrics.observedCalories.note,/不补齐缺测/);
  const unknown=rideDetails({duration:2,streams:[{time:0,power:200},{time:10,power:200},{time:110,power:200}]});assert.equal(unknown.metrics.timerSeconds.value,null);assert.equal(unknown.metrics.pausedSeconds.value,null);assert.equal(unknown.metrics.calories.value,null);
});

test('coasting, pedaling, stopped time and weighted percentile use paired observed data',()=>{
  const r=rideDetails({duration:40/60,streams:[{time:0,power:0,speed:10,cadence:0},{time:10,power:200,speed:10,cadence:90},{time:30,power:0,speed:0,cadence:0},{time:40,power:100,speed:100,cadence:100}]});
  assert.equal(r.metrics.coastingSeconds.value,10);assert.equal(r.metrics.pedalingSeconds.value,20);assert.equal(r.metrics.stoppedSeconds.value,10);assert.equal(r.metrics.movingSeconds.value,30);close(r.metrics.avgMovingPower.value,4000/30);assert.equal(r.metrics.avgPedalingCadence.value,90);assert.equal(r.metrics.cadenceRevolutions.value,30);assert.equal(r.metrics.speedP95.value,36);assert.equal(r.metrics.speedCoveragePct.value,100);
  const missing=rideDetails({duration:10/60,streams:[{time:0,speed:10},{time:10,speed:10}]});assert.equal(missing.metrics.coastingSeconds.value,null);assert.match(missing.metrics.coastingSeconds.missingReason,/缺测/);
});

test('aggregate distance and timer can supply average speed but cannot manufacture peaks, balance or training effects',()=>{
  const r=rideDetails({distance:30,duration:60,fitSummary:{elapsedSeconds:3600,timerSeconds:3000}});
  assert.equal(r.metrics.avgSpeed.value,36);assert.equal(r.metrics.avgSpeed.source,'derived');assert.equal(r.metrics.maxSpeed.value,null);assert.equal(r.metrics.speedP95.value,null);assert.equal(r.metrics.aerobicEffect.value,null);assert.match(r.metrics.aerobicEffect.missingReason,/厂商模型/);assert.equal(r.metrics.balance.value,null);assert.match(r.metrics.balance.missingReason,/单侧/);assert.equal(r.metrics.avgTemperature.value,null);assert.match(r.metrics.avgTemperature.missingReason,/温度传感器/);
});

test('zero mechanical work remains a valid measured zero, and caloric inference requires at least 95 percent coverage',()=>{
  const stationary=rideDetails({duration:1,streams:[{time:0,power:0,timerActive:true},{time:30,power:0,timerActive:true},{time:60,power:0,timerActive:true}]});assert.equal(stationary.metrics.workKj.value,0);assert.equal(stationary.metrics.calories.value,0);assert.equal(stationary.metrics.calories.source,'estimated');
  const make=end=>rideDetails({duration:100/60,fitSummary:{timerSeconds:100,elapsedSeconds:100},streams:Array.from({length:end/5+1},(_,i)=>({time:i*5,power:200}))});assert.equal(make(90).metrics.calories.value,null);assert.ok(make(95).metrics.calories.value>0);assert.equal(make(95).metrics.powerCoveragePct.value,95);
});
