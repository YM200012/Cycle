import { importFIT } from './fit.mjs';
const number = value => value === undefined || value === '' ? undefined : Number(value);
const unescape = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const tag = (s, name) => { const m = s.match(new RegExp('<(?:[\\w-]+:)?' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[\\w-]+:)?' + name + '>', 'i')); return m ? unescape(m[1].trim()) : undefined; };
const tags = (s, name) => [...s.matchAll(new RegExp('<(?:[\\w-]+:)?' + name + '(?:\\s[^>]*)?>[\\s\\S]*?<\\/(?:[\\w-]+:)?' + name + '>', 'gi'))].map(m => m[0]);
function haversine(a, b) {
  const r = x => x * Math.PI / 180;
  const x = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lon - a.lon) / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}
function parseCSV(text) {
  const rows = []; let row = [], field = '', quote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { if (quote && text[i + 1] === '"') { field += '"'; i++; } else quote = !quote; }
    else if (!quote && (c === ',' || c === '\n')) { row.push(field.replace(/\r$/, '')); field = ''; if (c === '\n') { rows.push(row); row = []; } }
    else field += c;
  }
  if (quote) throw Error('CSV 引号未闭合');
  if (field || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
  const header = (rows.shift() || []).map(s => s.replace(/^\uFEFF/, '').trim().toLowerCase());
  return rows.filter(r => r.some(v => v.trim())).map(r => Object.fromEntries(header.map((h, i) => [h, r[i]?.trim() || ''])));
}
export function importFile(filename, buffer, settings) {
  if (/\.fit$/i.test(filename)) return importFIT(filename, buffer, settings);
  const text = buffer.toString('utf8');
  if (/\.csv$/i.test(filename)) {
    const rows = parseCSV(text);
    if (!rows.length || !('date' in rows[0])) throw Error('CSV 需要 date,name,type,duration,distance,load,power,hr 列；duration 单位为分钟，distance 单位为公里');
    return rows.map(r => ({ name: r.name || '导入活动', date: r.date.slice(0, 10), type: r.type || 'Ride', duration: number(r.duration) ?? 0, distance: number(r.distance) ?? 0, load: number(r.load) ?? 0, power: number(r.power), hr: number(r.hr), notes: r.notes || '', planned: /^(true|1)$/i.test(r.planned || ''), streams: [] }));
  }
  if (!/\.(gpx|tcx)$/i.test(filename)) throw Error('请选择 FIT、CSV、GPX 或 TCX 文件');
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw Error('不支持含外部实体或 DTD 的 XML');
  const isGPX = /\.gpx$/i.test(filename);
  const groups = isGPX ? tags(text, 'trk') : tags(text, 'Activity');
  if (!groups.length) throw Error('文件没有可解析的轨迹或活动');
  return groups.map(group => {
    const points = tags(group, isGPX ? 'trkpt' : 'Trackpoint');
    let start, previous, distance = 0;
    const streams = [];
    for (const point of points) {
      const timestamp = Date.parse(tag(point, isGPX ? 'time' : 'Time'));
      if (!Number.isFinite(timestamp)) continue;
      start ??= timestamp;
      let lat, lon;
      if (isGPX) {
        lat = number(point.match(/\blat=["']([^"']+)["']/i)?.[1]); lon = number(point.match(/\blon=["']([^"']+)["']/i)?.[1]);
        if (Number.isFinite(lat) && Number.isFinite(lon)) { if (previous) distance += haversine(previous, { lat, lon }); previous = { lat, lon }; }
      } else {
        distance = number(tag(point, 'DistanceMeters')) ?? distance;
        lat = number(tag(point, 'LatitudeDegrees')); lon = number(tag(point, 'LongitudeDegrees'));
      }
      const s = { time: (timestamp - start) / 1000, distance, power: number(tag(point, isGPX ? 'power' : 'Watts')), hr: number(tag(isGPX ? point : tag(point, 'HeartRateBpm') || '', isGPX ? 'hr' : 'Value')), cadence: number(tag(point, isGPX ? 'cad' : 'Cadence')), altitude: number(tag(point, isGPX ? 'ele' : 'AltitudeMeters')), lat: Number.isFinite(lat) ? lat : undefined, lon: Number.isFinite(lon) ? lon : undefined, speed: number(tag(point, isGPX ? 'speed' : 'Speed')) };
      streams.push(Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined)));
    }
    if (!streams.length) throw Error('轨迹没有有效时间戳');
    const avg = key => { const a = streams.filter(s => Number.isFinite(s[key])); return a.length ? a.reduce((n, s) => n + s[key], 0) / a.length : undefined; };
    const duration = streams.at(-1).time / 60, power = avg('power');
    const typeText = tag(group, 'type') || group.match(/\bSport="([^"]+)"/i)?.[1] || '';
    return { name: tag(group, 'name') || filename.replace(/\.[^.]+$/, ''), type: /run/i.test(typeText) ? 'Run' : /swim/i.test(typeText) ? 'Swim' : 'Ride', startedAt:new Date(start).toISOString(),date: new Date(start).toISOString().slice(0, 10), duration, distance: distance / 1000, load: power === undefined ? 0 : Math.round(duration / 60 * (power / settings.ftp) ** 2 * 100), power, hr: avg('hr'), planned: false, notes: power === undefined ? '训练负荷可手动填写。' : '训练负荷由平均功率和 FTP 近似估算。', streams };
  });
}
