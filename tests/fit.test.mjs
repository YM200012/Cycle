import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Encoder, Profile } from '@garmin/fitsdk';
import { importFile } from '../src/import.mjs';
import { defaults } from '../src/metrics.mjs';
import { effectiveStreams } from '../src/analysis.mjs';

const base = Date.parse('2026-11-01T00:00:00Z');
const time = seconds => new Date(base + seconds * 1000);
const position = degrees => Math.round(degrees / 180 * 2147483648);
function encode(writer, type = 'activity') {
  const encoder = new Encoder();
  encoder.onMesg(Profile.MesgNum.FILE_ID, { type, manufacturer: 'development', product: 1, timeCreated: time(0) });
  const emit = (name, object) => encoder.onMesg(Profile.MesgNum[name], object);
  writer(emit);
  return Buffer.from(encoder.close());
}
const session = (start, end, sport = 'cycling', other = {}) => ({ startTime: time(start), timestamp: time(end), totalElapsedTime: end - start, totalTimerTime: end - start, sport, ...other });

test('official Garmin FIT fixture passes CRC, reads real file records and retains device lap', () => {
  const buffer = readFileSync(new URL('./fixtures/garmin-activity.fit', import.meta.url));
  const manifest = JSON.parse(readFileSync(new URL('./fixtures/manifest.json', import.meta.url)));
  assert.equal(createHash('sha256').update(buffer).digest('hex'), manifest.fixtures[0].sha256);
  const [a] = importFile('Activity.fit', buffer, defaults);
  assert.equal(a.date, '2021-07-20');
  assert.equal(a.type, 'Workout'); // The official generated sample is stand-up paddleboarding, not cycling.
  assert.equal(a.duration, 3601 / 60);
  assert.equal(a.streams.length, 3601);
  assert.equal(a.streams[0].power, 150);
  assert.equal(a.streams[0].lat, 0);
  assert.equal(a.streams[0].speed, 1);
  assert.ok(a.streams[1].lon > 0);
  assert.equal(a.laps.length, 1);
  assert.equal(a.laps[0].end, 3601); // Preserve the device boundary beyond the last observed sample.
  assert.match(a.notes, /近似估算/);
});

test('FIT session grouping preserves zero power, coordinates, SDK scale and summary units', () => {
  const buffer = encode(emit => {
    for (const seconds of [0, 5, 10]) emit('RECORD', { timestamp: time(seconds), power: seconds === 0 ? 0 : 250, heartRate: 140, cadence: 90, distance: seconds * 10, speed: 10, altitude: 123.4, positionLat: position(31), positionLong: position(121) });
    emit('LAP', { startTime: time(0), timestamp: time(10), totalElapsedTime: 10 });
    emit('SESSION', session(0, 11, 'cycling', { totalDistance: 110, avgPower: 230 }));
    for (const seconds of [20, 25, 30]) emit('RECORD', { timestamp: time(seconds), distance: (seconds - 20) * 3, heartRate: 155 });
    emit('SESSION', session(20, 31, 'running', { totalDistance: 33 }));
  });
  const [ride, run] = importFile('multi.fit', buffer, defaults);
  assert.equal(ride.type, 'Ride'); assert.equal(run.type, 'Run');
  assert.equal(ride.power, 230); assert.equal(ride.distance, .11);
  assert.equal(ride.duration, 11 / 60);
  assert.equal(ride.streams[0].power, 0);
  assert.ok(Math.abs(ride.streams[0].lat - 31) < 1e-6);
  assert.ok(Math.abs(ride.streams[0].lon - 121) < 1e-6);
  assert.equal(ride.streams[0].speed, 10);
  assert.ok(Math.abs(ride.streams[0].altitude - 123.4) < 1e-8);
  assert.equal(ride.laps[0].end, 10);
  assert.equal(run.streams[0].time, 0);
  assert.equal(run.streams.length, 3);
  assert.equal(Object.hasOwn(run, 'power'), false);
  assert.equal(run.load, 0);
  assert.equal(run.streams.some(point => Object.hasOwn(point, 'power')), false);
});

test('FIT timer stops remain missing-data boundaries without collapsing elapsed time', () => {
  const buffer = encode(emit => {
    emit('EVENT', { timestamp: time(0), event: 'timer', eventType: 'start' });
    for (const seconds of [0, 5, 15, 20, 25, 30]) emit('RECORD', { timestamp: time(seconds), power: 200, heartRate: 140, positionLat: position(31), positionLong: position(121) });
    emit('EVENT', { timestamp: time(10), event: 'timer', eventType: 'stop' });
    emit('EVENT', { timestamp: time(20), event: 'timer', eventType: 'start' });
    emit('SESSION', session(0, 31, 'cycling', { totalTimerTime: 21 }));
  });
  const [a] = importFile('pause.fit', buffer, defaults);
  assert.equal(a.duration, 31 / 60);
  assert.equal(a.streams.find(s => s.time === 10).power, undefined);
  assert.equal(a.streams.find(s => s.time === 10).timerActive, false);
  assert.equal(a.streams.find(s => s.time === 15).power, 200);
  assert.equal(a.streams.find(s => s.time === 15).hr, 140);
  assert.equal(a.streams.find(s => s.time === 15).timerActive, false);
  assert.ok(a.streams.find(s => s.time === 15).lat > 30);
  assert.equal(a.streams.find(s => s.time === 20).power, 200);
  assert.equal(a.streams.find(s => s.time === 20).timerActive, true);
  assert.equal(a.streams.at(-1).time, 30);
  assert.match(a.notes, /设备计时 21 秒/);
  const effective = effectiveStreams(a);
  assert.equal(effective.find(s => s.time === 15).power, undefined);
  assert.equal(effective.find(s => s.time === 15).hr, undefined);
  assert.equal(effective.find(s => s.time === 20).power, 200);
  assert.equal(a.streams.find(s => s.time === 15).power, 200);
});

test('FIT summary fallback excludes preserved paused samples', () => {
  const buffer = encode(emit => {
    for (const seconds of [0, 5, 10, 15, 20, 25, 30]) emit('RECORD', { timestamp: time(seconds), power: seconds >= 10 && seconds < 20 ? 900 : 200, heartRate: seconds >= 10 && seconds < 20 ? 220 : 140 });
    emit('EVENT', { timestamp: time(0), event: 'timer', eventType: 'start' });
    emit('EVENT', { timestamp: time(10), event: 'timer', eventType: 'stop' });
    emit('EVENT', { timestamp: time(20), event: 'timer', eventType: 'start' });
    emit('SESSION', session(0, 31, 'cycling', { totalTimerTime: 21 }));
  });
  const [a] = importFile('paused-summary.fit', buffer, defaults);
  assert.equal(a.streams.find(s => s.time === 15).power, 900);
  assert.equal(a.power, 200);
  assert.equal(a.hr, 140);
});

test('FIT duplicate and out-of-order timestamps are normalized without inventing missing data', () => {
  const buffer = encode(emit => {
    emit('RECORD', { timestamp: time(10), power: 200 });
    emit('RECORD', { timestamp: time(0), power: 100 });
    emit('RECORD', { timestamp: time(5), power: 150 });
    emit('RECORD', { timestamp: time(5), heartRate: 135 });
    emit('SESSION', session(0, 11));
  });
  const [a] = importFile('duplicate.fit', buffer, defaults);
  assert.deepEqual(a.streams.map(point => point.time), [0, 5, 10]);
  assert.equal(a.streams[1].power, 150);
  assert.equal(a.streams[1].hr, 135);
  assert.equal(a.streams[0].hr, undefined);
});

test('FIT rejects corruption, truncation, non-activity data and overlapping sessions', () => {
  const buffer = encode(emit => {
    emit('RECORD', { timestamp: time(0), power: 200 });
    emit('RECORD', { timestamp: time(10), power: 200 });
    emit('SESSION', session(0, 11));
  });
  const corrupted = Buffer.from(buffer); corrupted[corrupted.length - 1] ^= 255;
  assert.throws(() => importFile('crc.fit', corrupted, defaults), /CRC/);
  assert.throws(() => importFile('truncated.fit', buffer.subarray(0, buffer.length - 5), defaults), /CRC/);
  assert.throws(() => importFile('bad.fit', Buffer.from('not a FIT activity'), defaults), /文件头/);
  const workout = encode(() => {}, 'workout');
  assert.throws(() => importFile('workout.fit', workout, defaults), /不是活动文件/);
  const overlap = encode(emit => {
    emit('RECORD', { timestamp: time(0), power: 200 });
    emit('RECORD', { timestamp: time(20), power: 200 });
    emit('SESSION', session(0, 20)); emit('SESSION', session(10, 21));
  });
  assert.throws(() => importFile('overlap.fit', overlap, defaults), /时间重叠/);
});

test('FIT rejects valid timestamp records outside declared sessions without silently dropping them', () => {
  const buffer = encode(emit => {
    for (const seconds of [0, 5, 10, 20]) emit('RECORD', { timestamp: time(seconds), power: 200 });
    emit('SESSION', session(0, 10));
  });
  assert.throws(() => importFile('orphan.fit', buffer, defaults), /1 个.*采样未归属任何活动段.*未导入任何活动/);
  const gaps = encode(emit => {
    for (const seconds of [0, 5, 10, 15, 20, 25]) emit('RECORD', { timestamp: time(seconds), power: 200 });
    emit('SESSION', session(0, 10)); emit('SESSION', session(20, 25));
  });
  assert.throws(() => importFile('between.fit', gaps, defaults), /1 个.*采样未归属任何活动段/);
});

test('FIT preserves true device lap end within elapsed session after final sample', () => {
  const buffer = encode(emit => {
    for (const seconds of [0, 10, 20, 30, 40, 50]) emit('RECORD', { timestamp: time(seconds), power: 200 });
    emit('LAP', { startTime: time(0), timestamp: time(60), totalElapsedTime: 60 });
    emit('SESSION', session(0, 60));
  });
  const [a] = importFile('lap-tail.fit', buffer, defaults);
  assert.equal(a.streams.at(-1).time, 50);
  assert.equal(a.duration, 1);
  assert.equal(a.laps[0].start, 0);
  assert.equal(a.laps[0].end, 60);
});

test('GPX and TCX retain supplied coordinates and speed without inferring absent speed', () => {
  const gpx = '<gpx><trk><trkseg><trkpt lat="31" lon="121"><time>2026-11-01T00:00:00Z</time><speed>8.5</speed></trkpt><trkpt lat="31.001" lon="121.001"><time>2026-11-01T00:00:01Z</time></trkpt></trkseg></trk></gpx>';
  const a = importFile('route.gpx', Buffer.from(gpx), defaults)[0];
  assert.equal(a.streams[0].lat, 31); assert.equal(a.streams[0].lon, 121);
  assert.equal(a.streams[0].speed, 8.5); assert.equal(a.streams[1].speed, undefined);
  const tcx = '<TrainingCenterDatabase><Activities><Activity Sport="Biking"><Lap><Track><Trackpoint><Time>2026-11-01T00:00:00Z</Time><Position><LatitudeDegrees>31.1</LatitudeDegrees><LongitudeDegrees>121.2</LongitudeDegrees></Position><Extensions><ns3:TPX><ns3:Speed>9.5</ns3:Speed></ns3:TPX></Extensions></Trackpoint></Track></Lap></Activity></Activities></TrainingCenterDatabase>';
  const b = importFile('route.tcx', Buffer.from(tcx), defaults)[0];
  assert.equal(b.streams[0].lat, 31.1); assert.equal(b.streams[0].lon, 121.2); assert.equal(b.streams[0].speed, 9.5);
});

test('trainer session stamped at start is reconstructed without losing records or valid laps',()=>{
 const buffer=encode(emit=>{
  for(let second=9;second<=848;second++)emit('RECORD',{timestamp:time(second),power:second===9?0:150,heartRate:140,cadence:88,speed:7,distance:(second-9)*7});
  const bounds=[9,97,103,223,343,463,583,703,823,848];
  for(let i=1;i<bounds.length;i++)emit('LAP',{startTime:time(bounds[i-1]),timestamp:time(bounds[i]),totalElapsedTime:bounds[i]-bounds[i-1]});
  emit('LAP',{startTime:time(0),timestamp:time(0),totalElapsedTime:830.162});
  emit('SESSION',session(0,0,'cycling',{subSport:'virtualActivity',totalElapsedTime:830.162,totalTimerTime:830.162}));
 });
 const originalHash=createHash('sha256').update(buffer).digest('hex'),[a]=importFile('trainer.fit',buffer,defaults);
 assert.equal(a.type,'Ride');assert.equal(a.streams.length,840);assert.equal(a.streams[0].time,9);assert.equal(a.streams.at(-1).time,848);assert.equal(a.streams[0].power,0);
 assert.equal(a.fitSummary.elapsedSeconds,848);assert.equal(a.fitSummary.timerSeconds,830.162);assert.equal(a.laps.length,9);assert.equal(a.laps.at(-1).end,848);
 assert.match(a.notes,/兼容时间修正/);assert.match(a.notes,/虚拟骑行/);assert.equal(createHash('sha256').update(buffer).digest('hex'),originalHash);
});

test('degenerate trainer session uses declared elapsed tail when it exceeds last measured point',()=>{
 const b=encode(emit=>{for(let second=0;second<=50;second+=5)emit('RECORD',{timestamp:time(second),power:200});emit('SESSION',session(0,0,'cycling',{totalElapsedTime:60,totalTimerTime:55}));});
 const [a]=importFile('trainer-tail.fit',b,defaults);assert.equal(a.duration,1);assert.equal(a.streams.at(-1).time,50);assert.equal(a.fitSummary.timerSeconds,55);
});

test('trainer compatibility does not bridge ambiguous gaps or swallow remote orphan records',()=>{
 for(const times of [[0,5,10,800],[0,60,70]]){
  const b=encode(emit=>{for(const second of times)emit('RECORD',{timestamp:time(second),power:200});emit('SESSION',session(0,0,'cycling',{totalElapsedTime:times[1]===60?60:10}));});
  assert.throws(()=>importFile('ambiguous-trainer.fit',b,defaults),/采样未归属任何活动段/);
 }
});

test('multiple trainer sessions retain strict separate boundaries and overlap rejection',()=>{
 const valid=encode(emit=>{for(const second of [0,5,10,20,25,30])emit('RECORD',{timestamp:time(second),power:200});emit('SESSION',session(0,0,'cycling',{totalElapsedTime:10}));emit('SESSION',session(20,20,'cycling',{totalElapsedTime:10}));});
 const rides=importFile('two-trainers.fit',valid,defaults);assert.deepEqual(rides.map(a=>a.streams.length),[3,3]);
 const overlap=encode(emit=>{for(const second of [0,10,20,30])emit('RECORD',{timestamp:time(second),power:200});emit('SESSION',session(0,0,'cycling',{totalElapsedTime:20}));emit('SESSION',session(10,30));});
 assert.throws(()=>importFile('bad-trainer.fit',overlap,defaults),/时间重叠/);
});
