import test from 'node:test';
import assert from 'node:assert/strict';
import { rideBreakdown } from '../src/ride-breakdown.mjs';
const near = (a,b) => assert.ok(Math.abs(a-b)<1e-7,`${a} != ${b}`);

test('kilometre cuts apportion irregular records exactly and preserve missing metrics and input', () => {
  const a={streams:[{time:0,distance:0,power:100,hr:120,cadence:60,speed:50,altitude:10},{time:20,distance:1000,power:200,hr:150,cadence:90,speed:50,altitude:30},{time:40,distance:2000,power:300,speed:25,altitude:10},{time:60,distance:2500}]};
  const before=structuredClone(a),r=rideBreakdown(a,{maxHr:200});
  assert.equal(r.splits.length,3);near(r.splits[0].distanceKm,1);near(r.splits[0].observedSeconds,20);near(r.splits[0].avgSpeed,180);near(r.splits[0].avgPower,100);near(r.splits[0].ascent,20);near(r.splits[1].descent,20);near(r.splits[2].distanceKm,.5);assert.equal(r.splits[2].avgHr,null);assert.equal(r.splits[2].avgCadence,null);assert.equal(r.splits[2].ascent,null);assert.equal(r.splits[0].coveragePct,100);assert.deepEqual(a,before);
});

test('one record can cross multiple kilometre boundaries without duplicating time or energy', () => {
  const r=rideBreakdown({streams:[{time:0,distance:0,power:250,altitude:100,speed:100},{time:25,distance:2500,altitude:150}]});
  assert.equal(r.splits.length,3);near(r.splits[0].end,10);near(r.splits[1].start,10);near(r.splits[1].end,20);near(r.splits[2].start,20);near(r.splits.reduce((n,s)=>n+s.observedSeconds,0),25);near(r.splits.reduce((n,s)=>n+s.ascent,0),50);
});

test('gaps, timer stops and counter resets do not invent kilometres; coverage exposes missing spans', () => {
  const a={streams:[{time:0,distance:0,power:100,speed:20},{time:10,distance:200,timerActive:false,power:900,speed:20},{time:20,distance:400,power:200,speed:20},{time:30,distance:600,power:900,speed:20},{time:100,distance:2000,power:300,speed:20},{time:110,distance:2200,power:400,speed:20},{time:120,distance:100,power:500,speed:20},{time:130,distance:300,power:600,speed:20},{time:140,distance:500}]};
  const r=rideBreakdown(a);assert.equal(r.splits.length,1);const s=r.splits[0];near(s.distanceKm,1);near(s.observedSeconds,50);near(s.end,140);near(s.coveragePct,50/140*100);near(s.avgPower,(100+200+300+500+600)/5);near(r.speedZones.reduce((n,z)=>n+z.seconds,0),60); // Speed remains measured in a counter-reset interval, but distance is unknown.
});

test('laps integrate fractional boundaries, corrections and missing edges without extrapolation', () => {
  const a={streams:[{time:0,distance:0,power:0,speed:10,hr:100,cadence:0},{time:10,distance:100,power:200,speed:10,hr:150,cadence:80},{time:20,distance:200}],powerCorrections:[{time:0,power:100},{time:10,power:null}],laps:[{start:2.5,end:25,label:'完整设备圈'}]};
  const r=rideBreakdown(a,{maxHr:200}),lap=r.laps[0];near(lap.observedSeconds,17.5);near(lap.avgPower,100);near(lap.powerCoveragePct,7.5/22.5*100);near(lap.coveragePct,17.5/22.5*100);near(lap.avgSpeed,36);near(lap.distanceKm,.175);assert.equal(lap.label,'完整设备圈');assert.equal(r.cadenceZones[0].seconds,10);assert.equal(r.cadenceZones[3].seconds,10);assert.equal(r.hrZones[0].seconds,10);assert.equal(r.hrZones[2].seconds,10);
});

test('speed-only files generate observed splits, distribution bins are time weighted and terrain is explicit', () => {
  const a={streams:[{time:0,speed:10,power:0,cadence:0,hr:120,grade:3},{time:20,speed:20,cadence:100,hr:180,grade:-2},{time:40,speed:20,cadence:90,hr:100,grade:0},{time:60,speed:20,cadence:90,hr:100,grade:0},{time:80,speed:0,cadence:0,hr:100,grade:0}]};
  const r=rideBreakdown(a,{maxHr:200});near(r.splits.reduce((n,s)=>n+s.distanceKm,0),1.4);assert.equal(r.splits[0].distanceSource,'speed');near(r.speedZones[3].seconds,20);near(r.speedZones[5].seconds,60);near(r.terrain[0].seconds,20);near(r.terrain[1].seconds,40);near(r.terrain[2].distanceKm,.4);assert.deepEqual(rideBreakdown({}).splits,[]);assert.deepEqual(rideBreakdown({}).hrZones,[]);assert.deepEqual(rideBreakdown({}).terrain,[]);
});

test('unknown terrain distance remains null while a measured stationary distance remains zero', () => {
  const unknown=rideBreakdown({streams:[{time:0,grade:2},{time:10,grade:0}]});
  assert.equal(unknown.terrain[0].seconds,10);assert.equal(unknown.terrain[0].distanceKm,null);assert.equal(unknown.splits.length,0);
  const stationary=rideBreakdown({streams:[{time:0,distance:0,grade:2,speed:0},{time:10,distance:0}]});
  assert.equal(stationary.terrain[0].distanceKm,0);assert.equal(stationary.speedZones[0].seconds,10);assert.equal(stationary.splits.length,0);
});
