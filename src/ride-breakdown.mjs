import {elevationActivity} from './elevation.mjs';
import { rideSpeedStreams } from './ride-details.mjs';

const finite = n => typeof n === 'number' && Number.isFinite(n);
const valid = n => finite(n) && n >= 0;
const DISTANCE_EPSILON = 1e-7;

function frame(activity) {
  const corrections = new Map((activity.powerCorrections || []).map(c => [c.time, c.power]));
  const rows = rideSpeedStreams(activity), pieces = [];
  for (let i = 0; i + 1 < rows.length; i++) {
    const r = rows[i], next = rows[i + 1], dt = next.time - r.time;
    if (r.timerActive === false || !finite(r.time) || dt <= 0 || dt > 30) continue;
    let power = corrections.has(r.time) ? corrections.get(r.time) : r.power;
    if (!valid(power)) power = null;
    const cadence = valid(r.cadence) ? r.cadence : null;
    const hr = finite(r.hr) && r.hr > 0 ? r.hr : null;
    const speed = valid(r.speed) && r.speed <= 100 ? r.speed : null;
    let distance = null, distanceSource = null;
    if (valid(r.distance) && valid(next.distance)) {
      const delta = next.distance - r.distance;
      // An explicit counter reset is a boundary, never replaced by speed integration.
      if (delta >= 0 && delta / dt <= 100) { distance = delta; distanceSource = 'recorded'; }
    } else if (speed !== null) { distance = speed * dt; distanceSource = r.speedSource === 'gps' ? 'gps' : 'speed'; }
    let altitudeDelta = null;
    if (finite(r.altitude) && finite(next.altitude)) altitudeDelta = next.altitude - r.altitude;
    let grade = finite(r.grade) && Math.abs(r.grade) <= 50 ? r.grade : null;
    if (grade === null && altitudeDelta !== null && distance !== null && distance >= 5) {
      const inferred = altitudeDelta / distance * 100;
      if (Math.abs(inferred) <= 50) grade = inferred;
    }
    pieces.push({ start: r.time, end: next.time, seconds: dt, power, hr, cadence, speed, distance, distanceSource, altitudeDelta, grade });
  }
  return pieces;
}

function accumulator(label) {
  return { label, start: null, end: null, seconds: 0, distance: 0, distanceSeconds: 0, distancePieces: 0, sources: new Set(), power: 0, powerSeconds: 0, hr: 0, hrSeconds: 0, cadence: 0, cadenceSeconds: 0, ascent: 0, descent: 0, altitudePieces: 0 };
}
function add(a, p, start, end) {
  const seconds = end - start;
  if (seconds <= 0) return;
  const fraction = seconds / p.seconds;
  if (a.start === null) a.start = start;
  a.end = end; a.seconds += seconds;
  if (p.distance !== null) { a.distance += p.distance * fraction; a.distanceSeconds += seconds; a.distancePieces++; a.sources.add(p.distanceSource); }
  for (const key of ['power', 'hr', 'cadence']) if (p[key] !== null) { a[key] += p[key] * seconds; a[key + 'Seconds'] += seconds; }
  if (p.altitudeDelta !== null) { a.ascent += Math.max(0, p.altitudeDelta) * fraction; a.descent += Math.max(0, -p.altitudeDelta) * fraction; a.altitudePieces++; }
}
function finish(a, start = a.start, end = a.end) {
  const span = end - start;
  const pct = seconds => span > 0 ? Math.min(100, seconds / span * 100) : null;
  return {
    label: a.label, start, end,
    distanceKm: a.distancePieces ? a.distance / 1000 : null,
    distanceSource: a.sources.size > 1 ? 'mixed' : [...a.sources][0] || null,
    observedSeconds: a.seconds,
    avgSpeed: a.distanceSeconds ? a.distance / a.distanceSeconds * 3.6 : null,
    avgPower: a.powerSeconds ? a.power / a.powerSeconds : null,
    avgHr: a.hrSeconds ? a.hr / a.hrSeconds : null,
    avgCadence: a.cadenceSeconds ? a.cadence / a.cadenceSeconds : null,
    ascent: a.altitudePieces ? a.ascent : null,
    descent: a.altitudePieces ? a.descent : null,
    coveragePct: pct(a.seconds),
    distanceCoveragePct: pct(a.distanceSeconds),
    powerCoveragePct: pct(a.powerSeconds), hrCoveragePct: pct(a.hrSeconds), cadenceCoveragePct: pct(a.cadenceSeconds)
  };
}
function zones(pieces, key, bins, convert = value => value) {
  const result = bins.map(([label]) => ({ label, seconds: 0 }));
  for (const p of pieces) {
    if (p[key] === null) continue;
    const value = convert(p[key]), index = bins.findIndex(([, max]) => value < max);
    if (index >= 0) result[index].seconds += p.seconds;
  }
  return result;
}

/** Descriptive statistics from observed intervals only. No device/private training
 * effect model is reconstructed. Splits measure each observed kilometre, so gaps
 * do not become invented distance and their elapsed time remains visible in coverage. */
export function rideBreakdown(activity = {}, settings = {}) {
  activity=elevationActivity(activity);
  const pieces = frame(activity), splits = [];
  let current = accumulator('第 1 公里');
  for (const p of pieces) {
    if (p.distance === null) continue;
    let start = p.start, remainingDistance = p.distance;
    while (start < p.end - 1e-9) {
      const required = 1000 - current.distance;
      const distance = Math.min(remainingDistance, required);
      const end = p.distance > DISTANCE_EPSILON ? Math.min(p.end, start + distance / p.distance * p.seconds) : p.end;
      if (end <= start) break;
      add(current, p, start, end);
      start = end; remainingDistance = Math.max(0, remainingDistance - distance);
      if (current.distance >= 1000 - DISTANCE_EPSILON) {
        splits.push(finish(current)); current = accumulator(`第 ${splits.length + 1} 公里`);
      }
    }
  }
  if (current.distance > DISTANCE_EPSILON) { current.label = `末段 ${Math.round(current.distance)} m`; splits.push(finish(current)); }
  const laps = (activity.laps || []).flatMap((lap, i) => {
    if (!finite(lap.start) || !finite(lap.end) || lap.end <= lap.start) return [];
    const a = accumulator(lap.label || `设备圈 ${i + 1}`);
    for (const p of pieces) {
      if (p.end <= lap.start) continue;
      if (p.start >= lap.end) break;
      add(a, p, Math.max(p.start, lap.start), Math.min(p.end, lap.end));
    }
    return [finish(a, lap.start, lap.end)];
  });
  const speedZones = zones(pieces, 'speed', [['0–10 km/h', 10], ['10–20 km/h', 20], ['20–30 km/h', 30], ['30–40 km/h', 40], ['40–50 km/h', 50], ['50+ km/h', Infinity]], value => value * 3.6);
  const cadenceZones = zones(pieces, 'cadence', [['0 rpm', Number.MIN_VALUE], ['>0–<60 rpm', 60], ['60–<80 rpm', 80], ['80–<100 rpm', 100], ['100+ rpm', Infinity]]);
  const maxHr = finite(settings.maxHr) && settings.maxHr > 0 ? settings.maxHr : null;
  const hrZones = maxHr ? zones(pieces, 'hr', [['<60% HRmax', 60], ['60–<70% HRmax', 70], ['70–<80% HRmax', 80], ['80–<90% HRmax', 90], ['90%+ HRmax', Infinity]], value => value / maxHr * 100) : [];
  const terrain = [{label:'上坡（>1%）',seconds:0,distanceKm:0,distancePieces:0},{label:'平路（−1%–1%）',seconds:0,distanceKm:0,distancePieces:0},{label:'下坡（<−1%）',seconds:0,distanceKm:0,distancePieces:0}];
  let terrainSamples = 0;
  for (const p of pieces) {
    if (p.grade === null) continue;
    const index = p.grade > 1 ? 0 : p.grade < -1 ? 2 : 1;
    terrain[index].seconds += p.seconds;
    if (p.distance !== null) { terrain[index].distanceKm += p.distance / 1000; terrain[index].distancePieces++; }
    terrainSamples++;
  }
  return { splits, laps, speedZones, cadenceZones, hrZones, terrain: terrainSamples ? terrain.map(({distancePieces,...row})=>({...row,distanceKm:distancePieces?row.distanceKm:null})) : [], notes: [
    '每公里按有效采样可确认的距离累计；不是包含未记录路段的完整赛道里程。设备距离优先，缺少距离时积分有效速度。',
    '暂停、超过 30 秒的采样缺口和距离回退不补造距离。分段均速只取有距离的有效时间；覆盖率按分段经过时间计算。',
    '心率分区按当前设置的最大心率百分比；坡度优先记录值，否则由至少 5 m 的有效距离和海拔差推算，未平滑。'
  ] };
}
