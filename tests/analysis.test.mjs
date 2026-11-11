import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeActivity, effectiveStreams } from '../src/analysis.mjs';
const settings = { ftp: 250 };
const close = (a, b, tolerance = 1e-8) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);
const activity = (length, power = 200, hr = 140) => ({ streams: Array.from({ length: length + 1 }, (_, time) => ({ time, power: typeof power === 'function' ? power(time) : power, hr: typeof hr === 'function' ? hr(time) : hr })) });

test('constant power produces known NP, IF, TSS and time-weighted work', () => {
  const a = analyzeActivity(activity(3600), settings);
  close(a.summary.avgPower, 200); close(a.summary.normalizedPower, 200);
  close(a.summary.intensityFactor, .8); close(a.summary.tss, 64); close(a.summary.workKj, 720);
  close(a.summary.variabilityIndex, 1); close(a.summary.coverage, 1); close(a.summary.decoupling, 0);
  assert.equal(a.bestEfforts.find(e => e.seconds === 1200).start, 0);
});

test('summary integrates fractional timestamps and unequal sample durations exactly', () => {
  const a = analyzeActivity({ streams: [{ time: 0, power: 100 }, { time: .5, power: 300 }, { time: 2, power: 200 }, { time: 5, power: 0 }] }, settings);
  close(a.summary.avgPower, 220); close(a.summary.workKj, 1.1); close(a.summary.powerSeconds, 5);
  close(a.bestEfforts.find(e => e.seconds === 5).watts, 220);
  assert.equal(a.summary.normalizedPower, null);
});

test('NP uses complete trailing 30-second means; exactly 30 seconds is enough', () => {
  const exactly = analyzeActivity(activity(30), settings);
  close(exactly.summary.normalizedPower, 200);
  const short = analyzeActivity(activity(29), settings);
  assert.equal(short.summary.normalizedPower, null);
  const a = analyzeActivity(activity(31, t => t < 1 ? 100 : 300), settings);
  const first = (100 + 29 * 300) / 30, second = 300;
  close(a.summary.normalizedPower, ((first ** 4 + second ** 4) / 2) ** .25);
});

test('long gaps and absent power are not zero; low coverage blocks NP and TSS', () => {
  const data = [{ time: 0, power: 200 }, { time: 60, power: 400 }, { time: 90, power: 0 }];
  const a = analyzeActivity({ streams: data }, settings);
  close(a.summary.powerSeconds, 30); close(a.summary.avgPower, 400); close(a.summary.coverage, 1 / 3);
  assert.equal(a.summary.normalizedPower, null); assert.equal(a.summary.tss, null);
  assert.equal(a.bestEfforts.find(e => e.seconds === 30).start, 60);
  assert.equal(a.bestEfforts.some(e => e.seconds === 60), false);
  const zero = analyzeActivity(activity(60, 0), settings);
  close(zero.summary.normalizedPower, 0); close(zero.summary.tss, 0); close(zero.summary.avgPower, 0);
  assert.equal(zero.summary.variabilityIndex, null);
  const none = analyzeActivity({ streams: [{ time: 0, hr: 120 }, { time: 20, hr: 130 }, { time: 40, hr: 140 }] }, settings);
  assert.equal(none.summary.avgPower, null); assert.equal(none.summary.normalizedPower, null);
  close(none.summary.avgHr, 125); assert.deepEqual(none.bestEfforts, []);
});

test('automatic effort detection bridges short measured recovery but never a missing sample', () => {
  const a = activity(260, t => (t >= 10 && t < 80) || (t >= 120 && t < 190) ? 250 : 100);
  const result = analyzeActivity(a, settings);
  assert.deepEqual(result.intervals.map(i => [i.start, i.end, i.source]), [[10, 80, 'auto'], [120, 190, 'auto']]);
  assert.equal(result.groups.length, 1); assert.equal(result.groups[0].count, 2);
  close(result.groups[0].duration, 70); close(result.groups[0].avgPower, 250);
  const bridged = analyzeActivity(activity(100, t => t >= 40 && t < 50 ? 100 : 250), settings);
  assert.deepEqual(bridged.intervals.map(i => [i.start, i.end]), [[0, 100]]);
  const missing = activity(100, 250); delete missing.streams[45].power;
  assert.deepEqual(analyzeActivity(missing, settings).intervals, []);
});

test('manual ranges take priority over device laps; boundaries use continuous time weights', () => {
  const a = { ...activity(150, t => t < 70 ? 250 : 100), laps: [{ start: 0, end: 100, label: '设备第一圈' }], segments: [{ start: .5, end: 70.5, label: '自定义' }] };
  const result = analyzeActivity(a, settings);
  assert.equal(result.intervals.length, 1); assert.equal(result.intervals[0].label, '自定义');
  assert.equal(result.intervals[0].source, 'manual');
  close(result.intervals[0].avgPower, (69.5 * 250 + .5 * 100) / 70);
  const device = analyzeActivity({ ...a, segments: [] }, settings);
  assert.equal(device.intervals[0].source, 'device');
  close(result.summary.avgPower, device.summary.avgPower);
});

test('decoupling compares paired halves and declines insufficient coverage', () => {
  const a = analyzeActivity(activity(1200, 200, t => t < 600 ? 100 : 125), settings);
  close(a.summary.decoupling, 20);
  const missing = activity(1200, 200, 100);
  for (let i = 0; i < 100; i++) delete missing.streams[i].hr;
  assert.equal(analyzeActivity(missing, settings).summary.decoupling, null);
  assert.equal(analyzeActivity(activity(1199), settings).summary.decoupling, null);
});

test('best effort includes exact position and cannot cross gaps', () => {
  const a = analyzeActivity(activity(80, t => t >= 20 && t < 50 ? 500 : 100), settings);
  const thirty = a.bestEfforts.find(e => e.seconds === 30);
  assert.deepEqual(thirty, { seconds: 30, watts: 500, start: 20, end: 50 });
});

test('reversible corrections preserve originals, zero remains valid, null excludes power only', () => {
  const a = activity(120, 250, 130);
  a.powerCorrections = [{ time: 0, power: 0 }, { time: 1, power: null }, { time: 2, power: 200 }];
  const before = structuredClone(a.streams), changed = effectiveStreams(a);
  assert.equal(changed[0].power, 0); assert.equal(changed[1].power, undefined); assert.equal(changed[1].hr, 130);
  assert.equal(changed[2].power, 200); assert.deepEqual(a.streams, before);
  const result = analyzeActivity(a, settings);
  assert.equal(result.summary.correctionCount, 3); close(result.summary.powerSeconds, 119);
  close(result.summary.avgPower, (0 + 200 + 117 * 250) / 119);
});

test('plans and summary-only activities do not become measured power data', () => {
  const plan = analyzeActivity({ ...activity(1200), planned: true }, settings);
  assert.equal(plan.summary.normalizedPower, null); assert.deepEqual(plan.intervals, []);
  const manual = analyzeActivity({ duration: 90, power: 300 }, settings);
  assert.equal(manual.summary.elapsedSeconds, 5400); assert.equal(manual.summary.avgPower, null);
  assert.deepEqual(manual.bestEfforts, []);
});

test('coverage includes missing edges declared by session duration',()=>{
  const a={duration:1,streams:[{time:30,power:200},{time:60,power:200}]};
  const result=analyzeActivity(a,settings);
  close(result.summary.elapsedSeconds,60);close(result.summary.coverage,.5);
  assert.equal(result.summary.normalizedPower,null);assert.equal(result.summary.tss,null);
});

test('device lap remains visible when early session sampling is missing',()=>{
  const a={duration:10,streams:Array.from({length:591},(_,i)=>({time:i+10,power:250,hr:140})),laps:[{start:0,end:600,label:'Lap'}]};
  const result=analyzeActivity(a,settings);assert.equal(result.intervals.length,1);
  close(result.intervals[0].powerCoverage,590/600);assert.equal(result.intervals[0].start,0);
});
test('decoupling checks paired coverage in full elapsed halves including unrecorded edges',()=>{
  const a={duration:40,streams:Array.from({length:1201},(_,i)=>({time:i+600,power:200,hr:140}))};
  const result=analyzeActivity(a,settings);close(result.summary.coverage,.5);
  assert.equal(result.summary.decoupling,null);assert.ok(result.warnings.some(w=>w.includes('90%')));
});
