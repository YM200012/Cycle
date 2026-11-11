import { Decoder, Stream } from '@garmin/fitsdk';
import { FIT_SUMMARY_FIELDS, normalizeFitSummary, normalizeFitDevices } from './ride-details.mjs';

const finite = (value, min = 0, max = Infinity) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : undefined;
const timestamp = value => value instanceof Date && Number.isFinite(value.getTime()) ? value.getTime() : NaN;
const stops = new Set(['stop', 'stopAll', 'stopDisable', 'stopDisableAll', 'endDepreciated', 'endAllDepreciated']);
const starts = new Set(['start', 'beginDepreciated']);
const sportType = sport => /cycling|biking/i.test(sport || '') ? 'Ride' : /running|walking|hiking/i.test(sport || '') ? 'Run' : /swimming/i.test(sport || '') ? 'Swim' : 'Workout';
const compact = object => Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
// The FIT flag explicitly identifies the right side; without it the side is
// unknown, so it is not safe to label the value as left/right balance.
function leftBalance(value,hundred=false){if(!Number.isInteger(value)||!(value&(hundred?0x8000:0x80)))return undefined;const right=(value&(hundred?0x3fff:0x7f))/(hundred?100:1);return right<=100?100-right:undefined;}

function fitSummary(session,start,end){
  const fields={elapsedSeconds:(end-start)/1000,timerSeconds:session.totalTimerTime,movingSeconds:session.totalMovingTime,distance:session.totalDistance,
    avgSpeed:session.enhancedAvgSpeed??session.avgSpeed,maxSpeed:session.enhancedMaxSpeed??session.maxSpeed,
    ascent:session.totalAscent,descent:session.totalDescent,minAltitude:session.enhancedMinAltitude??session.minAltitude,maxAltitude:session.enhancedMaxAltitude??session.maxAltitude,
    avgPower:session.avgPower,maxPower:session.maxPower,avgHr:session.avgHeartRate,maxHr:session.maxHeartRate,
    avgCadence:session.avgCadence===undefined?undefined:session.avgCadence+(finite(session.avgFractionalCadence,0,1)||0),maxCadence:session.maxCadence===undefined?undefined:session.maxCadence+(finite(session.maxFractionalCadence,0,1)||0),
    avgTemperature:session.avgTemperature,maxTemperature:session.maxTemperature,minTemperature:session.minTemperature,
    calories:session.totalCalories,aerobicEffect:session.totalTrainingEffect,anaerobicEffect:session.totalAnaerobicTrainingEffect,
    avgBalance:leftBalance(session.leftRightBalance,true),workKj:session.totalWork===undefined?undefined:session.totalWork/1000,
    normalizedPower:session.normalizedPower,trainingStressScore:session.trainingStressScore,intensityFactor:session.intensityFactor};
  const valid={startedAt:new Date(start).toISOString()};
  for(const [key,[min,max]]of Object.entries(FIT_SUMMARY_FIELDS)){const value=finite(fields[key],min,max);if(value!==undefined)valid[key]=value;}
  if(valid.timerSeconds>valid.elapsedSeconds)delete valid.timerSeconds;
  if(valid.movingSeconds>valid.elapsedSeconds)delete valid.movingSeconds;
  return normalizeFitSummary(valid);
}
function fitDevices(messages){
  const devices=(messages.deviceInfoMesgs||[]).slice(0,50).map(row=>compact({
    name:row.productName||row.descriptor,manufacturer:row.manufacturer,product:row.garminProduct??row.product,
    softwareVersion:row.softwareVersion,type:row.deviceType
  })).map(row=>Object.fromEntries(Object.entries(row).filter(([,v])=>typeof v==='string'||typeof v==='number').map(([k,v])=>[k,String(v).slice(0,150)])));
  const file=messages.fileIdMesgs?.[0];
  if(!devices.length&&file)devices.push(compact({manufacturer:file.manufacturer===undefined?undefined:String(file.manufacturer).slice(0,150),product:file.product===undefined?undefined:String(file.product).slice(0,150)}));
  return normalizeFitDevices(devices);
}

function fitStream(record, origin, distanceOrigin) {
  const lat = finite(record.positionLat, -2147483648, 2147483647);
  const lon = finite(record.positionLong, -2147483648, 2147483647);
  const distance = finite(record.distance, 0, 10000000);
  return compact({
    time: (timestamp(record.timestamp) - origin) / 1000,
    power: finite(record.power, 0, 5000),
    hr: finite(record.heartRate, 0, 300),
    cadence: finite(record.cadence, 0, 300),
    altitude: finite(record.enhancedAltitude ?? record.altitude, -500, 20000),
    speed: finite(record.enhancedSpeed ?? record.speed, 0, 100),
    temperature: finite(record.temperature,-100,100),
    grade: finite(record.grade,-100,100),
    balance: leftBalance(record.leftRightBalance),
    distance: distance === undefined ? undefined : Math.max(0, distance - distanceOrigin),
    lat: lat === undefined ? undefined : lat * 180 / 2147483648,
    lon: lon === undefined ? undefined : lon * 180 / 2147483648
  });
}

/** Strict integrity validation precedes decoding. No FIT URLs or code are executed. */
export function importFIT(filename, buffer, settings) {
  if (buffer.length < 14 || ![12, 14].includes(buffer[0]) || buffer.toString('ascii', 8, 12) !== '.FIT') throw Error('FIT 文件头无效或不受支持');
  let messages;
  try {
    const decoder = new Decoder(Stream.fromBuffer(buffer));
    if (!decoder.isFIT() || !decoder.checkIntegrity()) throw Error('FIT 文件长度或 CRC 校验失败，文件可能不完整');
    const decoded = decoder.read({ applyScaleAndOffset: true, convertTypesToStrings: true, convertDateTimesToDates: true, includeUnknownData: false, mergeHeartRates: true });
    if (decoded.errors.length) throw Error('FIT 内容解码失败，未导入任何活动');
    messages = decoded.messages;
  } catch (error) {
    if (/FIT/.test(error.message)) throw error;
    throw Error('FIT 文件无法完整解码，请重新从设备导出');
  }
  if (messages.fileIdMesgs?.some(message => message.type !== 'activity')) throw Error('此 FIT 不是活动文件，暂不支持训练计划或设备配置 FIT');
  const records = (messages.recordMesgs || []).filter(record => Number.isFinite(timestamp(record.timestamp))).sort((a, b) => timestamp(a.timestamp) - timestamp(b.timestamp));
  if (!records.length) throw Error('FIT 文件没有带有效时间戳的活动采样');
  if (records.length > 150000) throw Error('FIT 文件采样超过 150000 点，请分段导出后重试');
  // Duplicate timestamps merge only fields actually present. Missing measurements stay missing.
  const unique = [];
  for (const row of records) {
    const previous = unique.at(-1);
    if (previous && timestamp(previous.timestamp) === timestamp(row.timestamp)) Object.assign(previous, compact(row));
    else unique.push({ ...row });
  }
  const first = timestamp(unique[0].timestamp), last = timestamp(unique.at(-1).timestamp);
  const sessionMessages=messages.sessionMesgs||[];
  const sessions = sessionMessages.map(session => {
    let start = timestamp(session.startTime), end = timestamp(session.timestamp);
    if (!Number.isFinite(start) && Number.isFinite(end) && finite(session.totalElapsedTime) !== undefined) start = end - session.totalElapsedTime * 1000;
    if (!Number.isFinite(end) && Number.isFinite(start) && finite(session.totalElapsedTime) !== undefined) end = start + session.totalElapsedTime * 1000;
    const timeNotes=[];
    // Some trainer exporters stamp SESSION.timestamp with startTime. Recover
    // this specific contradiction from elapsed time, leaving normal bounds strict.
    const elapsed=finite(session.totalElapsedTime,Number.MIN_VALUE);
    if(Number.isFinite(start)&&end===start&&elapsed!==undefined){
      end=start+elapsed*1000;
      timeNotes.push('兼容时间修正：设备 session 的结束时间等于开始时间但经过时长大于零，先按开始时间 + 标称经过时长重建边界。');
      // A single continuous record sequence may include a short stopped tail
      // excluded by that exporter's elapsed counter. Never stretch across a
      // large gap, another session, or arbitrary out-of-session records.
      const extension=last-end;
      if(sessionMessages.length===1&&first>=start&&first<=end&&extension>0&&extension<=Math.max(60000,elapsed*100)&&unique.every((r,i)=>!i||timestamp(r.timestamp)-timestamp(unique[i-1].timestamp)<=30000)){
        end=last;
        timeNotes.push(`单段连续采样延伸至最后实测时间；标称经过 ${elapsed} 秒，重建经过 ${(end-start)/1000} 秒。未补造采样，设备计时时长单独保留。`);
      }
    }
    return { session, start, end, timeNotes };
  }).filter(row => Number.isFinite(row.start) && Number.isFinite(row.end) && row.end >= row.start).sort((a, b) => a.start - b.start);
  if ((messages.sessionMesgs || []).length && sessions.length !== messages.sessionMesgs.length) throw Error('FIT 包含起止时间无效的活动段，未导入任何活动');
  if (!sessions.length) sessions.push({ session: {}, start: first, end: last });
  if (sessions.length > 50) throw Error('FIT 活动段过多，暂不支持该文件');
  for (let i = 1; i < sessions.length; i++) if (sessions[i].start < sessions[i - 1].end) throw Error('FIT 活动段时间重叠，无法可靠分配采样');
  const timerEvents = (messages.eventMesgs || []).filter(event => event.event === 'timer' && Number.isFinite(timestamp(event.timestamp)) && (starts.has(event.eventType) || stops.has(event.eventType))).sort((a, b) => timestamp(a.timestamp) - timestamp(b.timestamp));
  const imported = [];
  let consumedRecords = 0;
  for (let index = 0; index < sessions.length; index++) {
    const { session, start, end, timeNotes=[] } = sessions[index];
    const nextStart = sessions[index + 1]?.start ?? Infinity;
    const rows = unique.filter(record => { const time = timestamp(record.timestamp); return time >= start && time <= end && time < nextStart; });
    consumedRecords += rows.length;
    if (!rows.length) throw Error(`FIT 第 ${index + 1} 段没有可用采样，暂不支持此活动结构`);
    if ((end - start) / 1000 > 129600) throw Error('FIT 单段活动超过 36 小时，暂不支持');
    const distanceOrigin = finite(rows[0].distance) || 0;
    const points = new Map(rows.map(record => { const value = fitStream(record, start, distanceOrigin); return [value.time, value]; }));
    const events = timerEvents.filter(event => timestamp(event.timestamp) >= start && timestamp(event.timestamp) <= timestamp(rows.at(-1).timestamp));
    // Explicit timer stops create a missing-data boundary, even if paused records are present.
    for (const event of events) {
      const time = (timestamp(event.timestamp) - start) / 1000;
      if (!points.has(time)) points.set(time, { time });
    }
    const streams = [...points.values()].sort((a, b) => a.time - b.time);
    let active = true, eventIndex = 0, pausedSeconds = 0;
    for (let i = 0; i < streams.length; i++) {
      const point = streams[i];
      while (eventIndex < events.length && (timestamp(events[eventIndex].timestamp) - start) / 1000 <= point.time) active = starts.has(events[eventIndex++].eventType);
      point.timerActive = active;
      if (!active) {
        // Preserve original measurements. Analysis masks inactive rows using timerActive.
        if (streams[i + 1]) pausedSeconds += streams[i + 1].time - point.time;
      }
    }
    const average = key => { const values = streams.filter(point => point.timerActive !== false).map(point => point[key]).filter(Number.isFinite); return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined; };
    const duration = (end - start) / 60000;
    const power = finite(session.avgPower, 0, 5000) ?? average('power');
    const heartRate = finite(session.avgHeartRate, 0, 300) ?? average('hr');
    const timerSeconds = finite(session.totalTimerTime, 0, (end - start) / 1000);
    const trainingMinutes = timerSeconds === undefined ? Math.max(0, duration - pausedSeconds / 60) : timerSeconds / 60;
    const laps = (messages.lapMesgs || []).flatMap((lap, lapIndex) => {
      let lapStart = timestamp(lap.startTime);
      const lapEnd = timestamp(lap.timestamp);
      if (!Number.isFinite(lapStart) && Number.isFinite(lapEnd) && finite(lap.totalElapsedTime) !== undefined) lapStart = lapEnd - lap.totalElapsedTime * 1000;
      if (!Number.isFinite(lapStart) || !Number.isFinite(lapEnd) || lapStart < start || lapEnd > end) return [];
      const a = (lapStart - start) / 1000, b = (lapEnd - start) / 1000;
      return b > a ? [{ start: a, end: b, label: `设备圈 ${lapIndex + 1}`, source: 'device' }] : [];
    }).sort((a, b) => a.start - b.start);
    for (let lapIndex = 1; lapIndex < laps.length; lapIndex++) if (laps[lapIndex].start < laps[lapIndex - 1].end) throw Error('FIT 设备圈时间重叠，无法可靠导入');
    const notes = [
      'FIT 导入。',
      ...timeNotes,
      session.subSport==='virtualActivity'?'虚拟骑行：路线、速度与海拔来源于训练平台。':'',
      '日期按 UTC 归档，时长采用经过时间。',
      timerSeconds === undefined ? '' : `设备计时 ${Math.round(timerSeconds)} 秒。`,
      power === undefined ? '训练负荷可手动填写。' : '训练负荷：平均功率与设备计时近似估算。',
      '汇总采用设备记录与有效采样。'
    ].filter(Boolean).join(' ');
    imported.push(compact({
      name: (typeof session.sportProfileName === 'string' && session.sportProfileName.trim() ? session.sportProfileName.trim() : filename.replace(/\.fit$/i, '')) + (sessions.length > 1 ? ` · ${index + 1}` : ''),
      startedAt:new Date(start).toISOString(),indoor:/indoor|virtual/i.test(session.subSport||''),type: sportType(session.sport), date: new Date(start).toISOString().slice(0, 10), duration,
      distance: (finite(session.totalDistance, 0, 10000000) ?? streams.reduce((max, point) => Math.max(max, point.distance || 0), 0)) / 1000,
      load: power === undefined ? 0 : Math.round(trainingMinutes / 60 * (power / settings.ftp) ** 2 * 100),
      power, hr: heartRate, planned: false, notes, streams, laps,
      fitSummary:fitSummary(session,start,end),fitDevices:fitDevices(messages)
    }));
  }
  if (consumedRecords !== unique.length) throw Error(`FIT 有 ${unique.length - consumedRecords} 个带有效时间戳的采样未归属任何活动段，未导入任何活动；请核对文件中的 session 起止时间`);
  if (!imported.length) throw Error('FIT 活动段中没有可用采样');
  return imported;
}
