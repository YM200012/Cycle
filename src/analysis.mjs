import { resolveFtp } from './settings.mjs';
const MAX_SECONDS = 129600;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const positive = value => finite(value) && value >= 0;
const METHOD = '按有效时间加权采样。NP 使用完整 30 秒滚动窗口，活动指标要求至少 95% 功率覆盖。TSS 使用有效功率时长。自动努力段为 ≥90% FTP 且至少 60 秒高强度，可连接不超过 15 秒的有效恢复记录。';

/** Apply reversible overrides without altering the original activity or samples. */
export function effectiveStreams(activity = {}) {
  const rows = Array.isArray(activity.streams) ? activity.streams : [];
  const changes = new Map();
  for (const c of activity.powerCorrections || []) {
    if (finite(c?.time) && (c.power === null || (positive(c.power) && c.power <= 5000))) changes.set(c.time, c.power);
  }
  if (!changes.size&&!rows.some(row=>row.timerActive===false)) return rows;
  return rows.map(row => {
    if(row.timerActive===false){const copy={...row};delete copy.power;delete copy.hr;delete copy.cadence;delete copy.speed;return copy;}
    if (!changes.has(row.time)) return row;
    const copy = { ...row }, value = changes.get(row.time);
    if (value === null) delete copy.power;
    else copy.power = value;
    return copy;
  });
}

/**
 * Piecewise-constant values occupy [sample.time, next.time), for gaps <=30s.
 * Fractional timestamps are integrated into second bins with exact time weights.
 * Only fully covered one-second bins are valid for rolling-window calculations.
 */
export function resampleActivity(rows = []) {
  const samples = rows.filter(r => finite(r?.time) && r.time >= 0 && r.time <= MAX_SECONDS);
  const origin = samples[0]?.time ?? 0;
  const end = samples.at(-1)?.time ?? origin;
  const span = Math.max(0, end - origin), size = Math.ceil(span);
  const powerSum = new Float64Array(size), powerCovered = new Float64Array(size);
  const hrSum = new Float64Array(size), hrCovered = new Float64Array(size);
  const pieces = [];
  let energy = 0, powerSeconds = 0, hrTotal = 0, hrSeconds = 0;
  for (let i = 0; i + 1 < samples.length; i++) {
    const row = samples[i], next = samples[i + 1], dt = next.time - row.time;
    if (dt <= 0 || dt > 30) continue;
    const p = positive(row.power) ? row.power : null;
    const hr = positive(row.hr) && row.hr > 0 ? row.hr : null;
    if (p === null && hr === null) continue;
    pieces.push({ start: row.time, end: next.time, power: p, hr });
    if (p !== null) { energy += p * dt; powerSeconds += dt; }
    if (hr !== null) { hrTotal += hr * dt; hrSeconds += dt; }
    const start = row.time - origin, stop = next.time - origin;
    for (let second = Math.floor(start); second < Math.ceil(stop); second++) {
      if (second < 0 || second >= size) continue;
      const weight = Math.max(0, Math.min(stop, second + 1) - Math.max(start, second));
      if (p !== null) { powerSum[second] += p * weight; powerCovered[second] += weight; }
      if (hr !== null) { hrSum[second] += hr * weight; hrCovered[second] += weight; }
    }
  }
  const power = new Float64Array(size), hr = new Float64Array(size);
  power.fill(NaN); hr.fill(NaN);
  for (let i = 0; i < size; i++) {
    if (powerCovered[i] >= 1 - 1e-8) power[i] = powerSum[i] / powerCovered[i];
    if (hrCovered[i] >= 1 - 1e-8) hr[i] = hrSum[i] / hrCovered[i];
  }
  return { origin, end, span, power, hr, pieces, energy, powerSeconds, hrTotal, hrSeconds };
}

function prefixes(values) {
  const sums = new Float64Array(values.length + 1), counts = new Uint32Array(values.length + 1);
  for (let i = 0; i < values.length; i++) {
    const valid = finite(values[i]);
    sums[i + 1] = sums[i] + (valid ? values[i] : 0);
    counts[i + 1] = counts[i] + (valid ? 1 : 0);
  }
  return { sums, counts };
}

function rangeStats(frame, start, end) {
  let pSum = 0, hSum = 0, ps = 0, hs = 0;
  for (const piece of frame.pieces) {
    if (piece.end <= start) continue;
    if (piece.start >= end) break;
    const dt = Math.min(piece.end, end) - Math.max(piece.start, start);
    if (dt <= 0) continue;
    if (piece.power !== null) { pSum += piece.power * dt; ps += dt; }
    if (piece.hr !== null) { hSum += piece.hr * dt; hs += dt; }
  }
  return { avgPower: ps ? pSum / ps : null, avgHr: hs ? hSum / hs : null, workKj: ps ? pSum / 1000 : null, powerCoverage: ps / (end - start) };
}

function automaticRanges(frame, ftp, options) {
  if (!positive(ftp) || ftp === 0) return [];
  const found = [], threshold = options.thresholdPct / 100 * ftp;
  let start = null, lastHighEnd = null, highSeconds = 0, recovery = 0;
  function flush() {
    if (start !== null && highSeconds >= options.minSeconds) found.push({ start: frame.origin + start, end: frame.origin + lastHighEnd, label: `努力段 ${found.length + 1}`, source: 'auto' });
    start = null; lastHighEnd = null; highSeconds = 0; recovery = 0;
  }
  for (let i = 0; i < frame.power.length; i++) {
    const p = frame.power[i];
    if (!finite(p)) { flush(); continue; }
    if (p >= threshold) {
      if (start === null) start = i;
      highSeconds++; lastHighEnd = i + 1; recovery = 0;
    } else if (start !== null) {
      recovery++;
      if (recovery > options.recoverySeconds) flush();
    }
  }
  flush();
  return found;
}

function chooseRanges(activity, frame, ftp, elapsed, options) {
  const manual = Array.isArray(activity.segments) && activity.segments.length;
  const device = !manual && Array.isArray(activity.laps) && activity.laps.length;
  const source = manual ? activity.segments : device ? activity.laps : automaticRanges(frame, ftp, options);
  return source.filter(r => finite(r?.start) && finite(r?.end) && r.end > r.start && r.start >= 0 && r.end <= elapsed + 1e-8)
    .map((r, i) => ({ start: r.start, end: r.end, label: typeof r.label === 'string' && r.label.trim() ? r.label.trim() : `${manual ? '手动区间' : device ? '设备圈' : '努力段'} ${i + 1}`, source: manual ? 'manual' : device ? 'device' : 'auto' }));
}

function groupedIntervals(intervals) {
  const buckets = [];
  for (const [index, interval] of intervals.entries()) {
    if (interval.avgPower === null || interval.avgPower <= 0 || interval.powerCoverage < .95) continue;
    let bucket = buckets.find(b => Math.abs(interval.duration - b.first.duration) / b.first.duration <= .15 && Math.abs(interval.avgPower - b.first.avgPower) / b.first.avgPower <= .15);
    if (!bucket) { bucket = { first: interval, values: [], members: [] }; buckets.push(bucket); }
    bucket.values.push(interval); bucket.members.push(index);
  }
  return buckets.filter(b => b.values.length >= 2).map((b, index) => {
    const totalDuration = b.values.reduce((n, r) => n + r.duration, 0);
    return { label: `相近区间组 ${index + 1}`, count: b.values.length, duration: totalDuration / b.values.length, avgPower: b.values.reduce((n, r) => n + r.avgPower * r.duration, 0) / totalDuration, members: b.members };
  });
}

function decoupling(frame, warnings, elapsed) {
  if (elapsed < 1200) { warnings.push('功率/心率解耦需要至少 20 分钟的活动时间。'); return null; }
  const split = elapsed / 2;
  const halves = [{ seconds: 0, power: 0, hr: 0 }, { seconds: 0, power: 0, hr: 0 }];
  for (const piece of frame.pieces) {
    if (piece.power === null || piece.hr === null) continue;
    for (let i = 0; i < 2; i++) {
      const start = Math.max(piece.start, i ? split : 0), end = Math.min(piece.end, i ? elapsed : split), dt = end - start;
      if (dt <= 0) continue;
      halves[i].seconds += dt; halves[i].power += piece.power * dt; halves[i].hr += piece.hr * dt;
    }
  }
  if (halves.some(h => h.seconds / (elapsed / 2) < .9)) { warnings.push('功率/心率解耦需要完整活动前后半段各至少 90% 的有效配对采样。'); return null; }
  const ratios = halves.map(h => h.power / h.hr);
  if (!finite(ratios[0]) || ratios[0] <= 0 || !finite(ratios[1])) { warnings.push('解耦计算需要有效的功率与心率配对。'); return null; }
  return (ratios[0] - ratios[1]) / ratios[0] * 100;
}


/** Observed-scope metrics never replace strict whole-ride TSS used by apply-load. */
function displayMetrics(activity, settings, summary, frame, np = null) {
  const out = {}, device = activity.fitSummary || {};
  const note = `仅有效记录：功率 ${Math.round(frame.powerSeconds)} 秒，经过时间覆盖 ${((summary.coverage || 0) * 100).toFixed(1)}%；超过 30 秒的缺口不补零，30 秒窗口不跨缺口。`;
  const put = (key, value, scope, detail) => { out[key] = {value: finite(value) ? value : null, scope, note: detail}; };
  const observed = {normalizedPower: np, intensityFactor: np !== null && summary.ftp ? np / summary.ftp : null,
    variabilityIndex: np !== null && summary.avgPower > 0 ? np / summary.avgPower : null};
  observed.tss = observed.intensityFactor !== null ? frame.powerSeconds / 3600 * observed.intensityFactor ** 2 * 100 : null;
  const deviceKeys = {normalizedPower:'normalizedPower', intensityFactor:'intensityFactor', tss:'trainingStressScore'};
  for (const key of ['normalizedPower','intensityFactor','tss','variabilityIndex','workKj','decoupling']) {
    if (finite(summary[key])) put(key, summary[key], key==='workKj'?'有效采样积分':'全程覆盖校验通过', '按完整活动覆盖要求计算；机械功仅积分有效功率。');
    else if (!summary.correctionCount && finite(device[deviceKeys[key]])) put(key, device[deviceKeys[key]], '设备记录', '来自 FIT 设备汇总；可能使用设备当时的 FTP 与厂商算法。');
    else put(key, observed[key], '仅有效记录', note + (key === 'tss' ? ' TSS 仅累计已记录功率时长，不能代表整次活动负荷，也不会自动写入训练负荷。' : ''));
  }
  const paired = frame.pieces.filter(p => p.power !== null && p.hr !== null);
  const pairedSeconds = paired.reduce((n,p) => n + p.end - p.start, 0);
  let cursor = 0, halves = [{power:0,hr:0},{power:0,hr:0}];
  for (const p of paired) {
    const dt = p.end - p.start, first = Math.max(0, Math.min(dt, pairedSeconds / 2 - cursor));
    for (const [i, seconds] of [[0,first],[1,dt-first]]) { halves[i].power += p.power * seconds; halves[i].hr += p.hr * seconds; }
    cursor += dt;
  }
  const ratios = halves.map(h => h.hr > 0 ? h.power / h.hr : null);
  if (!finite(out.decoupling.value) && pairedSeconds >= 1200 && ratios[0] > 0 && finite(ratios[1]))
    put('decoupling', (ratios[0] - ratios[1]) / ratios[0] * 100, '仅有效配对记录', '按累计有效功率/心率配对时长等分前后半程，比较平均功率/平均心率比的下降百分比；不跨缺口插值。受强度变化影响，不等同于有氧能力评价。');
  put('pairedSeconds', pairedSeconds || null, '采样计算', '同一时段同时具有功率和心率的有效秒数，包含实测零功率。');
  const pairedHr = pairedSeconds ? halves.reduce((n,h)=>n+h.hr,0) / pairedSeconds : null;
  put('efficiencyFactor', np !== null && pairedHr > 0 && pairedSeconds >= frame.powerSeconds * .95 ? np / pairedHr : null, '仅有效记录', '效率系数 EF = 有效记录 NP / 配对平均心率；要求至少 95% 有效功率时段具有心率。');
  put('normalizedPowerPerKg', out.normalizedPower.value !== null && settings.weight > 0 ? out.normalizedPower.value / settings.weight : null, out.normalizedPower.scope, '当前展示 NP / 当前设置体重；继承 NP 的记录范围。');
  const nonzero = frame.pieces.filter(p=>p.power > 0), nonzeroSeconds = nonzero.reduce((n,p)=>n+p.end-p.start,0);
  put('nonzeroPower', nonzeroSeconds ? nonzero.reduce((n,p)=>n+p.power*(p.end-p.start),0)/nonzeroSeconds : null, '仅有效记录', '仅大于零功率的时间加权均值，排除实测零功率，缺测不计入。');
  put('zeroPowerPct', frame.powerSeconds ? (frame.powerSeconds-nonzeroSeconds)/frame.powerSeconds*100 : null, '仅有效记录', '实测零功率秒数 / 有效功率秒数，不把缺测当作零功率。');
  put('aboveFtpSeconds', summary.ftp && frame.powerSeconds ? frame.pieces.reduce((n,p)=>n+(p.power > summary.ftp ? p.end-p.start : 0),0) : null, '仅有效记录', '逐点功率严格大于活动生效 FTP 的有效持续时间。');
  return out;
}

export function analyzeActivity(activity = {}, settings = {}) {
  const resolved = resolveFtp(activity, settings);
  const options = {thresholdPct: settings.effortThresholdPct ?? 90, minSeconds: settings.effortMinSeconds ?? 60, recoverySeconds: settings.effortRecoverySeconds ?? 15};
  const summary = { elapsedSeconds: null, powerSeconds: null, coverage: null, avgPower: null, normalizedPower: null, intensityFactor: null, tss: null, variabilityIndex: null, workKj: null, avgHr: null, decoupling: null, correctionCount: 0 };
  Object.assign(summary, {ftp:resolved.ftp, ftpSource:resolved.source, ftpEffectiveDate:resolved.effectiveDate});
  const result = { summary, intervals: [], groups: [], bestEfforts: [], distributions: {power:[], hr:[]}, powerZones: [], effortOptions:options, method: METHOD.replace('≥90% FTP 且至少 60 秒高强度，可连接不超过 15 秒', `≥${options.thresholdPct}% FTP 且至少 ${options.minSeconds} 秒高强度，可连接不超过 ${options.recoverySeconds} 秒`), warnings: [] };
  if (activity.planned) { result.warnings.push('完成活动后可生成采样分析。'); return result; }
  const streams = effectiveStreams(activity), frame = resampleActivity(streams);
  const correctedTimes = new Set((activity.powerCorrections || []).filter(c => finite(c?.time) && (c.power === null || (positive(c.power) && c.power <= 5000))).map(c => c.time));
  summary.correctionCount = streams.filter(s => s.timerActive!==false&&correctedTimes.has(s.time)).length;
  if (summary.correctionCount) result.warnings.push(`已应用 ${summary.correctionCount} 个可逆功率修正；原始采样保持不变。`);
  if (!frame.span) {
    if (positive(activity.duration)) summary.elapsedSeconds = activity.duration * 60;
    result.displayMetrics = displayMetrics(activity, settings, summary, frame);
    result.warnings.push('时间序列需要连续采样记录。');
    return result;
  }
  const ftp = resolved.ftp;
  // Include uncovered session edges instead of reporting only the measured core.
  const elapsed = Math.max(frame.span,frame.end,positive(activity.duration)?activity.duration*60:0);
  summary.elapsedSeconds = elapsed;
  summary.powerSeconds = frame.powerSeconds;
  summary.coverage = frame.powerSeconds / elapsed;
  summary.avgPower = frame.powerSeconds ? frame.energy / frame.powerSeconds : null;
  summary.avgHr = frame.hrSeconds ? frame.hrTotal / frame.hrSeconds : null;
  summary.workKj = frame.powerSeconds ? frame.energy / 1000 : null;
  const { sums, counts } = prefixes(frame.power);
  let fourthPowers = 0, windows = 0;
  for (let end = 30; end <= frame.power.length; end++) {
    if (counts[end] - counts[end - 30] !== 30) continue;
    fourthPowers += ((sums[end] - sums[end - 30]) / 30) ** 4; windows++;
  }
  if (!frame.powerSeconds) result.warnings.push('补充有效功率采样后可查看功率指标。');
  else if (summary.coverage < .95 - 1e-10) result.warnings.push('当前功率覆盖低于 95%，已展示有效记录范围内的指标。');
  else if (!windows) result.warnings.push('NP、IF 与 TSS 需要完整的 30 秒功率窗口。');
  else {
    summary.normalizedPower = (fourthPowers / windows) ** .25;
    summary.variabilityIndex = summary.avgPower > 0 ? summary.normalizedPower / summary.avgPower : null;
    if (ftp) {
      summary.intensityFactor = summary.normalizedPower / ftp;
      summary.tss = frame.powerSeconds * summary.normalizedPower * summary.intensityFactor / (ftp * 3600) * 100;
    } else result.warnings.push('设置 FTP 后可计算 IF 与 TSS。');
  }
  if (frame.powerSeconds && frame.powerSeconds < elapsed - 1e-8) result.warnings.push('采样存在功率缺口；最大均值只计算完整有效窗口，NP 只汇总完整的 30 秒窗口。');
  summary.decoupling = decoupling(frame, result.warnings, elapsed);
  result.displayMetrics = displayMetrics(activity, settings, summary, frame, windows ? (fourthPowers / windows) ** .25 : null);
  const bounds = [.55, .75, .9, 1.05, 1.2, 1.5, Infinity];
  // Histograms integrate original pieces, preserving fractional time and missing values.
  function distribution(key, thresholds, unit) {
    const bins=thresholds.map((upper,i)=>({lower:i?thresholds[i-1]:0,upper:Number.isFinite(upper)?upper:null,seconds:0}));
    for(const piece of frame.pieces){const v=piece[key];if(v===null)continue;const index=thresholds.findIndex(upper=>v<upper);bins[index].seconds+=piece.end-piece.start;}
    return bins.map(b=>({...b,label:b.upper===null?`${b.lower}+ ${unit}`:`${b.lower}–<${b.upper} ${unit}`}));
  }
  result.distributions.power=distribution('power',Array.from({length:20},(_,i)=>(i+1)*50).concat(Infinity),'W');
  result.distributions.hr=distribution('hr',[60,80,100,110,120,130,140,150,160,170,180,190,200,220,Infinity],'bpm');
  result.powerZones=ftp?bounds.map((upper,i)=>({name:`Z${i+1}`,seconds:frame.pieces.reduce((sum,p)=>sum+(p.power!==null&&bounds.findIndex(b=>p.power/ftp<=b)===i?p.end-p.start:0),0)})):[];
  result.intervals = chooseRanges(activity, frame, ftp, elapsed, options).map(range => {
    const stats = rangeStats(frame, range.start, range.end);
    const zone = stats.avgPower !== null && ftp ? `Z${bounds.findIndex(b => stats.avgPower / ftp <= b) + 1}` : null;
    return { ...range, duration: range.end - range.start, ...stats, zone };
  });
  result.groups = groupedIntervals(result.intervals);
  for (const seconds of [5, 30, 60, 180, 300, 480, 600, 720, 900, 1200, 1800, 3600]) {
    let best = null;
    for (let end = seconds; end <= frame.power.length; end++) {
      if (counts[end] - counts[end - seconds] !== seconds) continue;
      const watts = (sums[end] - sums[end - seconds]) / seconds;
      if (!best || watts > best.watts) best = { seconds, watts, start: frame.origin + end - seconds, end: frame.origin + end };
    }
    if (best) result.bestEfforts.push(best);
  }
  return result;
}
