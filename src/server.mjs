import {parseAppleHealthStream,inspectAppleHealthStream} from './apple-health.mjs';
import {priorAwareEstimates} from './performance-estimates.mjs';
import {createWeatherStore} from './weather-store.mjs';
import {normalizeWeather,weatherSummary} from './weather.mjs';
import {createTerrainStore} from './terrain.mjs';
import {normalizeElevation} from './elevation.mjs';
import { createMapTileStore } from './map-tiles.mjs';
import http from 'node:http';
import {appleHealthUploadStream,MAX_HEALTH_BYTES} from './apple-health-upload.mjs';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, open, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { defaults, dateKey, fitness, powerAnalysis } from './metrics.mjs';
import { importFile } from './import.mjs';
import { analyzeActivity } from './analysis.mjs';
import { normalizeAnalysisSettings,resolveFtp } from './settings.mjs';
import { parseWorkout, normalizeIntervals, workoutZwo } from './workout.mjs';
import { normalizePlan, normalizePlanOrigin, validatePlanningLinks, planningOverview, schedulePlan } from './planning.mjs';
import { normalizeGear, gearUsage, normalizeGoal, validateWorkspace, validateGearAssignment, goalOverview } from './workspace.mjs';
import { normalizeFitSummary, normalizeFitDevices } from './ride-details.mjs';
const importBaseKeys=['time','power','hr','cadence','altitude','speed','distance','lat','lon','timerActive'];
const importSignature=a=>createHash('sha256').update(JSON.stringify(a.streams?.length?(a.streams||[]).map(s=>Object.fromEntries(importBaseKeys.filter(k=>s[k]!==undefined).map(k=>[k,s[k]]))):Object.fromEntries(['date','type','duration','distance','power','hr'].map(k=>[k,a[k]])))).digest('hex');
const root = dirname(fileURLToPath(import.meta.url));
const types = new Set(['Ride', 'Run', 'Swim', 'Workout', 'Note']);
const bad = message => { const error = Error(message); error.status = 400; throw error; };
const finite = (value, name, min = 0, max = 1e6, fallback = 0) => {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) bad(`${name} 必须在 ${min}–${max} 范围内`);
  return value;
};
function validDate(value) { if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '1900-01-01' || value > '2200-12-31' || !Number.isFinite(Date.parse(value)) || dateKey(value) !== value) bad('日期格式必须为有效的 YYYY-MM-DD'); return value; }
function str(value, name, limit = 10000, fallback = '') { if (value === undefined) return fallback; if (typeof value !== 'string' || value.length > limit) bad(`${name} 必须为不超过 ${limit} 字符的文本`); return value; }
function normalizeActivity(a, id = randomUUID(), workout = false) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) bad('活动必须为对象');
  if(workout&&a.workoutText!==undefined){const parsed=parseWorkout(a.workoutText);a={...a,...parsed};}
  const name = str(a.name, '名称', 250).trim(); if (!name) bad('请填写名称');
  const type = a.type || 'Ride'; if (!types.has(type)) bad('不支持的活动类型');
  if (a.planned !== undefined && typeof a.planned !== 'boolean') bad('planned 必须为布尔值');
  const result = { id, name, type, duration: finite(a.duration, '时长', 0, 2160), distance: finite(a.distance, '距离', 0, 10000), load: finite(a.load, '训练负荷', 0, 10000), power: finite(a.power, '功率', 0, 5000, null), hr: finite(a.hr, '心率', 0, 300, null), notes: str(a.notes, '备注'), planned: a.planned ?? false, intervals: [], streams: [] };
  if (!workout) result.date = validDate(a.date);
  else {result.description = str(a.description, '描述');if(a.workoutText!==undefined)result.workoutText=a.workoutText;}
  if (a.demo === true) result.demo = true;
  if(a.ftpEstimateMethod!==undefined){if(!['auto','p60','p20','cp','p8'].includes(a.ftpEstimateMethod))bad('FTP 估测方法无效');result.ftpEstimateMethod=a.ftpEstimateMethod;}
  if(a.indoor!==undefined){if(typeof a.indoor!=='boolean')bad('室内标记必须为布尔值');result.indoor=a.indoor;}
  if(a.startedAt!==undefined){if(typeof a.startedAt!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(a.startedAt)||!Number.isFinite(Date.parse(a.startedAt)))bad('开始时间无效');result.startedAt=new Date(a.startedAt).toISOString();}
  result.intervals = normalizeIntervals(a.intervals);
  if (a.streams !== undefined && (!Array.isArray(a.streams) || a.streams.length > 150000)) bad('采样数据最多 150000 个点');
  let lastTime = -1;
  result.streams = (a.streams || []).map(s => {
    if (!s || typeof s !== 'object') bad('采样点必须为对象');
    const time = finite(s.time, '采样时间', 0, 129600); if (time <= lastTime) bad('采样时间必须严格递增'); lastTime = time;
    const value = { time };
    if(s.timerActive!==undefined){if(typeof s.timerActive!=='boolean')bad('计时标记必须为布尔值');value.timerActive=s.timerActive;}
    for (const [key,min,max] of [['power',0,5000],['hr',0,300],['cadence',0,300],['altitude',-500,20000],['distance',0,10000000],['lat',-90,90],['lon',-180,180],['speed',0,100],['temperature',-100,100],['grade',-100,100],['balance',0,100]]) if (s[key] !== undefined && s[key] !== null) value[key] = finite(s[key],key,min,max);
    return value;
  });
  if(a.elevationCorrection!==undefined)result.elevationCorrection=normalizeElevation(a.elevationCorrection,result.streams);
  if(a.fitSummary!==undefined)result.fitSummary=normalizeFitSummary(a.fitSummary);
  if(a.fitDevices!==undefined)result.fitDevices=normalizeFitDevices(a.fitDevices);
  if(a.weather!==undefined&&a.weather!==null)result.weather=normalizeWeather(a.weather,result);
  if(a.importHash!==undefined){if(typeof a.importHash!=='string'||!/^[a-f0-9]{64}$/.test(a.importHash))bad('导入文件摘要无效');result.importHash=a.importHash;}
  if(a.importSessionIndex!==undefined){if(!Number.isInteger(a.importSessionIndex)||a.importSessionIndex<0||a.importSessionIndex>20000)bad('导入活动段序号无效');result.importSessionIndex=a.importSessionIndex;}
  const endTime = Math.max(result.streams.at(-1)?.time ?? 0,result.duration*60);
  for (const key of ['segments','laps']) {
    if(a[key]!==undefined&&(!Array.isArray(a[key])||a[key].length>500))bad('分段必须为最多 500 项的数组');
    let priorEnd=0;
    result[key]=(a[key]||[]).map(s=>{
      if(!s||typeof s!=='object')bad('分段格式无效');
      const start=finite(s.start,'分段开始',0,endTime),end=finite(s.end,'分段结束',0,endTime);
      if(end<=start||start<priorEnd)bad('分段必须按时间排序且不重叠，结束需大于开始');
      priorEnd=end;return {start,end,label:str(s.label,'分段名称',120),source:key==='laps'?'device':'manual'};
    });
  }
  if(a.analysisMode!==undefined&&!['auto','device','manual'].includes(a.analysisMode))bad('分段模式无效');
  if(a.analysisMode)result.analysisMode=a.analysisMode;
  if(a.powerCorrections!==undefined&&(!Array.isArray(a.powerCorrections)||a.powerCorrections.length>10000))bad('功率修正最多 10000 项');
  const times=new Set(result.streams.filter(s=>s.timerActive!==false).map(s=>s.time)),correctedTimes=new Set();
  result.powerCorrections=(a.powerCorrections||[]).map(c=>{
    if(!c||typeof c!=='object'||typeof c.time!=='number'||!times.has(c.time)||correctedTimes.has(c.time))bad('功率修正时间必须对应唯一原始采样点');
    if(c.power!==null&&(typeof c.power!=='number'||!Number.isFinite(c.power)||c.power<0||c.power>5000))bad('修正功率必须为 0–5000 W 或 null');
    correctedTimes.add(c.time);return {time:c.time,power:c.power};
  });
  if(a.loadMeta){const m=a.loadMeta;if(m.method!=='NP-TSS'||!Number.isFinite(Date.parse(m.calculatedAt)))bad('负荷计算来源无效');result.loadMeta={method:'NP-TSS',ftp:finite(m.ftp,'计算 FTP',1,1000),normalizedPower:finite(m.normalizedPower,'计算 NP',0,5000),calculatedAt:m.calculatedAt};if(m.ftpSource!==undefined){if(!['history','current'].includes(m.ftpSource))bad('FTP 来源无效');result.loadMeta.ftpSource=m.ftpSource;}if(m.ftpEffectiveDate!==undefined)result.loadMeta.ftpEffectiveDate=m.ftpEffectiveDate===null?null:validDate(m.ftpEffectiveDate);}
  if(workout&&(a.planOrigin!==undefined||a.completionId!==undefined))bad('训练库模板不能包含周期计划关联');
  if(a.gearId!==undefined&&a.gearId!==null&&a.gearId!==''){if(workout)bad('训练库模板不能指定器材');result.gearId=str(a.gearId,'器材 ID',100);if(!result.gearId.trim())bad('器材 ID 不能为空');}
  if(a.planOrigin!==undefined)result.planOrigin=normalizePlanOrigin(a.planOrigin);
  if(a.completionId!==undefined&&a.completionId!==null)result.completionId=str(a.completionId,'实际活动 ID',100);
  return result;
}
function normalizeSettings(value) {
  return { name: str(value.name, '姓名', 100, defaults.name), ftp: finite(value.ftp, 'FTP', 1, 1000, defaults.ftp), weight: finite(value.weight, '体重', 20, 300, defaults.weight), maxHr: finite(value.maxHr, '最大心率', 60, 250, defaults.maxHr), restHr: finite(value.restHr, '静息心率', 20, 200, defaults.restHr), ctlDays: finite(value.ctlDays, 'CTL 时间常数', 1, 365, defaults.ctlDays), atlDays: finite(value.atlDays, 'ATL 时间常数', 1, 365, defaults.atlDays), initialCtl: finite(value.initialCtl, '初始 CTL', 0, 1000), initialAtl: finite(value.initialAtl, '初始 ATL', 0, 1000), ...normalizeAnalysisSettings(value) };
}
function normalizeHealthMetric(m) {
  if(!m||typeof m!=='object'||Array.isArray(m))bad('健康指标格式无效');
  const out={};for(const [key,limit]of [['id',1000],['type',250],['label',500],['unit',100],['kind',20],['method',30]]){out[key]=str(m[key],'健康指标 '+key,limit);if(['id','type','label','kind','method'].includes(key)&&!out[key])bad('健康指标缺少 '+key);}
  if(!['quantity','category'].includes(out.kind)||!['sum','mean','last','union','count'].includes(out.method))bad('健康指标聚合方式无效');
  if(typeof m.value!=='number'||!Number.isFinite(m.value)||Math.abs(m.value)>1e15)bad('健康指标汇总值无效');out.value=m.value;
  if(!Number.isSafeInteger(m.sampleCount)||m.sampleCount<1||m.sampleCount>100000000||!Number.isFinite(m.start)||!Number.isFinite(m.end)||m.start>m.end||m.start<Date.UTC(1899,0,1)||m.end>Date.UTC(2202,0,1))bad('健康指标采样覆盖无效');
  out.sampleCount=m.sampleCount;out.start=m.start;out.end=m.end;
  if(!Array.isArray(m.names)||m.names.length>50||m.names.some(n=>typeof n!=='string'||n.length>250))bad('健康指标来源名称无效');out.names=[...new Set(m.names)];
  for(const key of ['min','max'])if(m[key]!==undefined){if(typeof m[key]!=='number'||!Number.isFinite(m[key])||Math.abs(m[key])>1e15)bad('健康指标范围无效');out[key]=m[key];}
  if(out.min!==undefined&&out.max!==undefined&&out.min>out.max)bad('健康指标范围顺序无效');
  for(const [key,limit]of [['state',500],['selectedSource',250],['sourcePolicy',100]])if(m[key]!==undefined)out[key]=str(m[key],'健康指标 '+key,limit);
  if(m.provider!==undefined){if(m.provider!=='Apple Health')bad('健康指标提供方无效');out.provider=m.provider;}
  if(m.importedAt!==undefined){if(typeof m.importedAt!=='string'||!Number.isFinite(Date.parse(m.importedAt)))bad('健康指标导入时间无效');out.importedAt=m.importedAt;}
  return out;
}
function normalizeWellness(w) {
  if (!w || typeof w !== 'object') bad('健康记录必须为对象');
  const r = { date: validDate(w.date), notes: str(w.notes, '备注') };
  for (const [key, min, max] of [['weight',20,300],['restHr',20,250],['hrv',0,500],['sleep',0,24],['fatigue',1,5]]) if (w[key] !== undefined && w[key] !== null && w[key] !== '') r[key] = finite(w[key],key,min,max);
  if(w.sources!==undefined){
    if(!w.sources||typeof w.sources!=='object'||Array.isArray(w.sources))bad('健康来源格式无效');r.sources={};
    for(const key of ['weight','restHr','hrv','sleep'])if(w.sources[key]!==undefined&&r[key]!==undefined){const m=w.sources[key];if(!m||m.provider!=='Apple Health'||!['bodyMass','restingHeartRate','heartRateVariabilitySDNN','sleepAnalysis'].includes(m.kind)||!['last','latest','mean','median','union'].includes(m.method)||!Array.isArray(m.names)||m.names.length>50||m.names.some(n=>typeof n!=='string'||n.length>250))bad('苹果健康来源无效');r.sources[key]={provider:'Apple Health',kind:m.kind,method:m.method,names:m.names};if(m.importedAt!==undefined){if(typeof m.importedAt!=='string'||!Number.isFinite(Date.parse(m.importedAt)))bad('健康导入时间无效');r.sources[key].importedAt=m.importedAt;}if(m.coverage!==undefined||m.sampleCount!==undefined){const c=m.coverage||m;if(!c||!Number.isSafeInteger(c.sampleCount)||c.sampleCount<1||!Number.isFinite(c.start)||!Number.isFinite(c.end)||c.start>c.end)bad('健康采样覆盖信息无效');r.sources[key].coverage={sampleCount:c.sampleCount,start:c.start,end:c.end};}}
  }
  if(w.healthMetrics!==undefined){if(!Array.isArray(w.healthMetrics)||w.healthMetrics.length>5000)bad('每日健康指标数量无效');r.healthMetrics=w.healthMetrics.map(normalizeHealthMetric);if(new Set(r.healthMetrics.map(m=>m.id)).size!==r.healthMetrics.length)bad('每日健康指标包含重复通道');}
  return r;
}
async function body(req,limit=40*1024*1024) {
  if (!req.headers['content-type']?.startsWith('application/json')) bad('请求必须使用 application/json');
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > limit) { const e = Error('请求超过 '+Math.round(limit/1024/1024)+' MB 限制'); e.status = 413; throw e; } chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { bad('JSON 格式无效'); }
}
export async function startServer({ dataDir = join(homedir(), '.cycle-local'), port = 0, terrainFetcher, weatherFetcher, healthUploadTtlMs=30*60000, healthPreviewTtlMs=15*60000 } = {}) {
  await mkdir(dataDir, { recursive: true });
  const mapTiles = createMapTileStore(dataDir);
  const weatherStore=createWeatherStore(dataDir,{fetcher:weatherFetcher||globalThis.fetch});
  const terrain=createTerrainStore(dataDir,{fetcher:terrainFetcher||globalThis.fetch});
  const db = new DatabaseSync(join(dataDir, 'cycle.sqlite'));
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS activities(id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS workouts(id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS plans(id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS gear(id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS goals(id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS imports(hash TEXT PRIMARY KEY, filename TEXT NOT NULL); CREATE TABLE IF NOT EXISTS wellness(id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS health_imports(id TEXT PRIMARY KEY, data TEXT NOT NULL);');
  const all = table => db.prepare(`SELECT data FROM ${table}`).all().map(r => JSON.parse(r.data));
  const getSettings = () => ({ ...defaults, ...JSON.parse(db.prepare('SELECT data FROM settings WHERE id=1').get()?.data || '{}') });
  const put = (table, id, data) => db.prepare(`INSERT OR REPLACE INTO ${table}(id,data) VALUES (?,?)`).run(id, JSON.stringify(data));
  const transaction = fn => { db.exec('BEGIN IMMEDIATE'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (e) { db.exec('ROLLBACK'); throw e; } };
  const healthPreviews=new Map(),healthUploads=new Map();let healthInspectBusy=false;
  const healthStaging=join(dataDir,'.health-staging');
  await rm(healthStaging,{recursive:true,force:true});await mkdir(healthStaging,{mode:0o700});
  const dropHealthUpload=async token=>{const upload=healthUploads.get(token);if(upload){healthUploads.delete(token);await rm(upload.path,{force:true});}for(const [key,p]of healthPreviews)if(p.uploadToken===token)healthPreviews.delete(key);};
  const cleanHealth=async()=>{const now=Date.now();for(const [key,value]of healthPreviews)if(value.expires<now){healthPreviews.delete(key);if(value.uploadToken)await dropHealthUpload(value.uploadToken);}for(const [key,value]of healthUploads)if(value.expires<now)await dropHealthUpload(key);};
  const healthTimer=setInterval(()=>cleanHealth().catch(()=>{}),Math.max(10,Math.min(60000,healthUploadTtlMs,healthPreviewTtlMs)));healthTimer.unref();
  const healthHistory=()=>all('health_imports').sort((a,b)=>b.importedAt.localeCompare(a.importedAt)).slice(0,100);
  const healthKeys=['weight','restHr','hrv','sleep'];
  const healthClass=(stored,row,key)=>{
    if(!Number.isFinite(stored[key]))return 'fill';if(stored[key]===row[key])return 'unchanged';
    if(stored.sources?.[key]?.provider!=='Apple Health')return 'protected';
    const old=stored.sources[key].coverage,fresh=row.sources?.[key]?.coverage;
    // A smaller sample set or narrower time span may be a partial export. Never
    // replace a more complete daily aggregate automatically in that case.
    if(old&&(!fresh||fresh.sampleCount<old.sampleCount||fresh.start>old.start||fresh.end<old.end))return 'protected';return 'update';
  };
  const healthMetricClass=(old,fresh)=>{
    if(!old)return 'fill';if(old.value===fresh.value)return 'unchanged';if(old.provider!=='Apple Health')return 'protected';
    if(fresh.sampleCount<old.sampleCount||fresh.start>old.start||fresh.end<old.end)return 'protected';return 'update';
  };
  const fullerMetric=(old,fresh)=>fresh.sampleCount>=old.sampleCount&&fresh.start<=old.start&&fresh.end>=old.end;
  let address;
  const server = http.createServer(async (req, res) => {
    const send = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(value)); };
    try {
      const host = req.headers.host;
      if (host !== `127.0.0.1:${address.port}` && host !== `localhost:${address.port}`) return send(403, { error: '不允许的 Host' });
      if (req.headers.origin && req.headers.origin !== `http://${host}`) return send(403, { error: '仅允许本地应用访问数据' });
      const url = new URL(req.url, `http://${host}`), path = url.pathname, method = req.method;
      const tileMatch=path.match(/^\/api\/map\/tiles\/(\d+)\/(\d+)\/(\d+)\.png$/);
      if(tileMatch&&method==='GET'){
        let tile;try{tile=await mapTiles.get(Number(tileMatch[1]),Number(tileMatch[2]),Number(tileMatch[3]),url.searchParams.get('online')==='1',url.searchParams.get('style')||'topo');}catch(e){if(e.status===404&&url.searchParams.get('online')!=='1'){res.writeHead(204,{'Cache-Control':'no-store'});return res.end();}throw e;}
        res.writeHead(200,{'Content-Type':tile.contentType||'image/png','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});return res.end(tile.data);
      }
      if (path === '/api/settings') {
        if (method === 'GET') return send(200, getSettings());
        if (method === 'PUT') { const settings = normalizeSettings({ ...getSettings(), ...await body(req) }); put('settings', 1, settings); return send(200, settings); }
      }
      const serviceMatch=path.match(/^\/api\/gear\/([^/]+)\/service$/);
      if(serviceMatch&&method==='POST'){
        const stored=db.prepare('SELECT data FROM gear WHERE id=?').get(serviceMatch[1]);if(!stored)return send(404,{error:'器材不存在'});
        const input=await body(req),gear=JSON.parse(stored.data);if(gear.services.length>=1000)bad('维护记录最多 1000 条');
        const odometer=gearUsage(gear,all('activities')).distance,next=normalizeGear({...gear,servicedAtKm:odometer,services:[...gear.services,{date:validDate(input?.date),odometer,notes:str(input?.notes,'维护说明')}]},gear.id);
        put('gear',next.id,next);return send(200,{...next,usage:gearUsage(next,all('activities'))});
      }
      const gearMatch=path.match(/^\/api\/gear(?:\/([^/]+))?$/);
      if(gearMatch){const id=gearMatch[1],stored=id?db.prepare('SELECT data FROM gear WHERE id=?').get(id):null;if(id&&!stored)return send(404,{error:'器材不存在'});
        if(method==='GET'){const activities=all('activities'),rows=(id?[JSON.parse(stored.data)]:all('gear').sort((a,b)=>a.name.localeCompare(b.name))).map(g=>({...g,usage:gearUsage(g,activities)}));return send(200,id?rows[0]:rows);}
        if(method==='POST'&&!id){const input=await body(req);if(input?.services!==undefined&&(!Array.isArray(input.services)||input.services.length))bad('维护记录请使用记录维护接口');if(input?.servicedAtKm!==undefined&&input.servicedAtKm!==0)bad('上次维护里程由维护接口记录');const gear=normalizeGear(input);put('gear',gear.id,gear);return send(201,{...gear,usage:gearUsage(gear,all('activities'))});}
        if(method==='PUT'&&id){const prior=JSON.parse(stored.data),input=await body(req);if(!input||typeof input!=='object'||Array.isArray(input))bad('器材格式无效');if(Object.hasOwn(input,'services')&&JSON.stringify(input.services)!==JSON.stringify(prior.services))bad('维护记录不能直接修改');if(Object.hasOwn(input,'servicedAtKm')&&input.servicedAtKm!==prior.servicedAtKm)bad('上次维护里程由维护接口记录');const next=normalizeGear({...prior,...input},id);validateWorkspace(all('activities'),all('gear').map(g=>g.id===id?next:g),all('goals'));put('gear',id,next);return send(200,{...next,usage:gearUsage(next,all('activities'))});}
        if(method==='DELETE'&&id){transaction(()=>{db.prepare('DELETE FROM gear WHERE id=?').run(id);for(const a of all('activities'))if(a.gearId===id){delete a.gearId;put('activities',a.id,a);}});return send(200,{ok:true});}
      }
      const goalMatch=path.match(/^\/api\/goals(?:\/([^/]+))?$/);
      if(goalMatch){const id=goalMatch[1],stored=id?db.prepare('SELECT data FROM goals WHERE id=?').get(id):null;if(id&&!stored)return send(404,{error:'目标不存在'});
        if(method==='GET'){const asOf=validDate(url.searchParams.get('asOf')||dateKey(new Date())),activities=all('activities'),rows=(id?[JSON.parse(stored.data)]:all('goals').sort((a,b)=>a.date.localeCompare(b.date))).map(g=>goalOverview(g,activities,asOf));return send(200,id?rows[0]:rows);}
        if(method==='POST'&&!id){const goal=normalizeGoal(await body(req));validateWorkspace(all('activities'),all('gear'),[...all('goals'),goal]);put('goals',goal.id,goal);return send(201,goalOverview(goal,all('activities')));}
        if(method==='PUT'&&id){const input=await body(req);if(!input||typeof input!=='object'||Array.isArray(input))bad('目标格式无效');const goal=normalizeGoal({...JSON.parse(stored.data),...input},id);validateWorkspace(all('activities'),all('gear'),all('goals').map(g=>g.id===id?goal:g));put('goals',id,goal);return send(200,goalOverview(goal,all('activities')));}
        if(method==='DELETE'&&id){db.prepare('DELETE FROM goals WHERE id=?').run(id);return send(200,{ok:true});}
      }
      const weatherMatch=path.match(/^\/api\/activities\/([^/]+)\/weather$/);
      if(weatherMatch&&['GET','POST','DELETE'].includes(method)){
        const id=weatherMatch[1],stored=db.prepare('SELECT data FROM activities WHERE id=?').get(id);if(!stored)return send(404,{error:'记录不存在'});
        const activity=JSON.parse(stored.data);
        if(method==='GET')return send(200,{weather:activity.weather||null,summary:weatherSummary(activity)});
        if(method==='DELETE')delete activity.weather;
        else {const input=await body(req);if(!input||typeof input.online!=='boolean')bad('请选择是否允许联网获取天气');activity.weather=await weatherStore.collect(activity,{online:input.online});}
        if(db.prepare('SELECT data FROM activities WHERE id=?').get(id)?.data!==stored.data)return send(409,{error:'活动在天气查询期间发生变化，请重试'});
        const next=normalizeActivity(activity,id);put('activities',id,next);return send(200,next);
      }
      const elevationMatch=path.match(/^\/api\/activities\/([^/]+)\/elevation-correction$/);
      if(elevationMatch&&['POST','DELETE'].includes(method)){
        const id=elevationMatch[1],stored=db.prepare('SELECT data FROM activities WHERE id=?').get(id);if(!stored)return send(404,{error:'记录不存在'});
        const activity=JSON.parse(stored.data);
        if(method==='DELETE')delete activity.elevationCorrection;
        else {const input=await body(req);if(!input||typeof input.online!=='boolean')bad('请选择是否允许联网查询地形');activity.elevationCorrection=await terrain.correct(activity,{online:input.online});}
        if(db.prepare('SELECT data FROM activities WHERE id=?').get(id)?.data!==stored.data)return send(409,{error:'活动在查询期间发生变化，请重试'});
        const next=normalizeActivity(activity,id);put('activities',id,next);return send(200,next);
      }
      const analysisMatch=path.match(/^\/api\/activities\/([^/]+)\/(analysis|segments|power-corrections|apply-load)$/);
      if(analysisMatch){
        const [,id,operation]=analysisMatch,stored=db.prepare('SELECT data FROM activities WHERE id=?').get(id);
        if(!stored)return send(404,{error:'记录不存在'});
        const activity=JSON.parse(stored.data),settings=getSettings();
        const mode=url.searchParams.get('mode')||activity.analysisMode||(activity.segments?.length?'manual':activity.laps?.length?'device':'auto');
        if(!['auto','manual','device'].includes(mode))bad('分析模式无效');
        const forAnalysis={...activity,...(mode==='auto'?{segments:[],laps:[]}:mode==='device'?{segments:[]}:{laps:[]})};
        if(operation==='analysis'&&method==='GET'){const analysis=analyzeActivity(forAnalysis,settings);return send(200,{...analysis,mode,estimates:priorAwareEstimates(activity.type==='Ride'&&!activity.planned&&!activity.demo?analysis.bestEfforts:[],settings.weight,{method:activity.ftpEstimateMethod||'auto',baseline:resolveFtp(activity,settings).ftp,baselineSource:resolveFtp(activity,settings).source,baselineDate:resolveFtp(activity,settings).effectiveDate,currentFtp:resolveFtp({date:dateKey(new Date())},settings).ftp})});}
        if(operation==='segments'&&method==='PUT'){
          const input=await body(req);if(!input||(!Array.isArray(input.segments)&&input.reset!==true))bad('请提供分段数组');
          if(input.reset!==true&&!input.segments.length)bad('手动分段至少一项；清除请使用重置');
          const next=normalizeActivity({...activity,segments:input.reset?[]:input.segments,analysisMode:input.reset?'auto':'manual'},id);
          put('activities',id,next);return send(200,next);
        }
        if(operation==='power-corrections'&&method==='PUT'){
          const input=await body(req);if(!Array.isArray(input?.corrections))bad('请提供功率修正数组');
          const next=normalizeActivity({...activity,powerCorrections:input.corrections},id);put('activities',id,next);return send(200,next);
        }
        if(operation==='apply-load'&&method==='POST'){
          await body(req);const {summary}=analyzeActivity(forAnalysis,settings);
          if(activity.planned||!Number.isFinite(summary.tss))bad('功率覆盖不足，无法应用计算负荷');
          const next=normalizeActivity({...activity,load:Math.round(summary.tss*10)/10,loadMeta:{method:'NP-TSS',ftp:summary.ftp,ftpSource:summary.ftpSource,ftpEffectiveDate:summary.ftpEffectiveDate,normalizedPower:summary.normalizedPower,calculatedAt:new Date().toISOString()}},id);
          put('activities',id,next);return send(200,next);
        }
        return send(405,{error:'请求方法不支持'});
      }
      if(path==='/api/planning'&&method==='GET')return send(200,planningOverview(all('activities'),validDate(url.searchParams.get('asOf')||dateKey(new Date()))));
      if(path==='/api/planning/match'&&method==='POST'){
        const input=await body(req),activities=all('activities'),planned=activities.find(a=>a.id===input?.plannedId);
        if(!planned||!planned.planned||!planned.planOrigin)bad('请选择待完成的周期计划训练');
        if(input.actualId!==null&&(typeof input.actualId!=='string'||!input.actualId))bad('请选择实际活动');
        const next={...planned};if(input.actualId===null)delete next.completionId;else next.completionId=input.actualId;
        validatePlanningLinks(activities.map(a=>a.id===next.id?next:a));put('activities',next.id,next);return send(200,next);
      }
      const batchMatch=path.match(/^\/api\/planning\/batches\/([^/]+)$/);
      if(batchMatch&&method==='DELETE'){
        const batch=all('activities').filter(a=>a.planOrigin?.batchId===batchMatch[1]);if(!batch.length)return send(404,{error:'批次不存在'});
        const removable=batch.filter(a=>a.planned&&!a.completionId);transaction(()=>{for(const a of removable)db.prepare('DELETE FROM activities WHERE id=?').run(a.id);});
        return send(200,{removed:removable.length,retained:batch.length-removable.length});
      }
      const scheduleMatch=path.match(/^\/api\/plans\/([^/]+)\/schedule$/);
      if(scheduleMatch&&method==='POST'){
        const stored=db.prepare('SELECT data FROM plans WHERE id=?').get(scheduleMatch[1]);if(!stored)return send(404,{error:'周期计划不存在'});
        const input=await body(req),plan=JSON.parse(stored.data),scheduled=schedulePlan(plan,input?.startDate);
        if(all('activities').some(a=>a.planOrigin?.planId===plan.id&&a.planOrigin?.startDate===input.startDate))return send(409,{error:'此计划已按该起始日期安排'});
        const activities=scheduled.activities.map(a=>normalizeActivity(a));validatePlanningLinks([...all('activities'),...activities]);
        transaction(()=>activities.forEach(a=>put('activities',a.id,a)));return send(201,{batchId:scheduled.batchId,activities});
      }
      const planMatch=path.match(/^\/api\/plans(?:\/([^/]+))?$/);
      if(planMatch){const id=planMatch[1],stored=id?db.prepare('SELECT data FROM plans WHERE id=?').get(id):null;if(id&&!stored)return send(404,{error:'周期计划不存在'});
        if(method==='GET')return send(200,id?JSON.parse(stored.data):all('plans').sort((a,b)=>a.name.localeCompare(b.name)));
        if(method==='POST'&&!id){const plan=normalizePlan(await body(req));put('plans',plan.id,plan);return send(201,plan);}
        if(method==='PUT'&&id){const plan=normalizePlan({...JSON.parse(stored.data),...await body(req)},id);put('plans',id,plan);return send(200,plan);}
        if(method==='DELETE'&&id){db.prepare('DELETE FROM plans WHERE id=?').run(id);return send(200,{ok:true});}
      }
      const workoutExport=path.match(/^\/api\/workouts\/([^/]+)\/export\.zwo$/);
      if(workoutExport&&method==='GET'){
        const stored=db.prepare('SELECT data FROM workouts WHERE id=?').get(workoutExport[1]);if(!stored)return send(404,{error:'训练不存在'});
        const content=workoutZwo(JSON.parse(stored.data));
        res.writeHead(200,{'Content-Type':'application/xml; charset=utf-8','Content-Disposition':'attachment; filename="cycle-workout.zwo"','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});return res.end(content);
      }
      const match = path.match(/^\/api\/(activities|workouts)(?:\/([^/]+))?$/);
      if (match) {
        const [, table, id] = match, workout = table === 'workouts';
        const stored = id ? db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id) : undefined;
        if (id && !stored) return send(404, { error: '记录不存在' });
        if (method === 'GET') return send(200, id ? JSON.parse(stored.data) : all(table).sort((a,b) => (a.date || a.name).localeCompare(b.date || b.name)));
        if (method === 'POST' && !id) { const input=await body(req);if(input?.planOrigin!==undefined||input?.completionId!==undefined)bad('请通过周期计划接口安排和关联训练');const a = normalizeActivity(input, randomUUID(), workout); if(!workout){validatePlanningLinks([...all('activities'),a]);validateGearAssignment(a,all('gear'));validateWorkspace([...all('activities'),a],all('gear'),all('goals'));}put(table, a.id, a); return send(201, a); }
        if (method === 'PUT' && id) {
          const prior=JSON.parse(stored.data),patch=await body(req),merged={...prior,...patch};
          if(Object.hasOwn(patch,'completionId')&&patch.completionId!==prior.completionId)bad('请通过计划执行页面修改实际活动关联');
          if(Object.hasOwn(patch,'planOrigin')&&JSON.stringify(patch.planOrigin?normalizePlanOrigin(patch.planOrigin):null)!==JSON.stringify(prior.planOrigin||null))bad('周期计划来源不能直接修改');
          if(table==='activities'&&Object.hasOwn(patch,'load')&&patch.load!==prior.load)merged.loadMeta=null;
          const a=normalizeActivity(merged,id,workout);if(!workout){const nextActivities=all('activities').map(row=>row.id===id?a:row);validatePlanningLinks(nextActivities);validateGearAssignment(a,all('gear'),prior);validateWorkspace(nextActivities,all('gear'),all('goals'));}put(table,id,a);return send(200,a);
        }
        if (method === 'DELETE' && id) {transaction(()=>{db.prepare(`DELETE FROM ${table} WHERE id=?`).run(id);if(!workout){const deleted=JSON.parse(stored.data);if(deleted.importHash&&!all('activities').some(a=>a.importHash===deleted.importHash))db.prepare('DELETE FROM imports WHERE hash=?').run(deleted.importHash);for(const row of all('activities'))if(row.completionId===id){delete row.completionId;put('activities',row.id,row);}for(const goal of all('goals'))if(goal.activityId===id){delete goal.activityId;put('goals',goal.id,goal);}}}); return send(200, { ok:true }); }
      }
      if(path==='/api/wellness/apple-health/history'&&method==='GET')return send(200,healthHistory());
      const healthUploadMatch=path.match(/^\/api\/wellness\/apple-health\/upload\/([a-f0-9-]+)$/);
      if(healthUploadMatch&&method==='DELETE'){await dropHealthUpload(healthUploadMatch[1]);return send(200,{ok:true});}
      if(path==='/api/wellness/apple-health/inspect'&&method==='POST'){
        if(healthInspectBusy)return send(409,{error:'另一份健康文件正在解析，请等待完成后重试'});healthInspectBusy=true;try{
        await cleanHealth();const zip=req.headers['content-type']?.startsWith('application/zip');if(!zip&&!req.headers['content-type']?.startsWith('application/xml'))bad('请选择苹果健康导出的 ZIP 或 export.xml 文件');
        if(Number(req.headers['content-length']||0)>MAX_HEALTH_BYTES)return send(413,{error:'健康 XML 超过 2 GB 限制'});
        for(const token of [...healthUploads.keys()])await dropHealthUpload(token);
        const uploadToken=randomUUID(),file=join(healthStaging,uploadToken+'.xml'),handle=await open(file,'wx',0o600);let bytes=0;
        async function* staged(){for await(const chunk of req){bytes+=chunk.length;if(bytes>MAX_HEALTH_BYTES)throw Object.assign(Error('健康 XML 超过 2 GB 限制'),{status:413});await handle.writeFile(chunk);yield chunk;}}
        let inventory;try{for await(const chunk of staged()){}await handle.close();inventory=await inspectAppleHealthStream(appleHealthUploadStream(file,{zip}));}catch(e){await handle.close().catch(()=>{});await rm(file,{force:true});e.status=e.status||400;throw e;}
        if(res.destroyed){await rm(file,{force:true});return;}const expires=Date.now()+healthUploadTtlMs;healthUploads.set(uploadToken,{path:file,zip,expires,inventory});return send(200,{...inventory,uploadToken,expires,lastImport:healthHistory()[0]||null});
        }finally{healthInspectBusy=false;}
      }
      if(path==='/api/wellness/apple-health/preview'&&method==='POST'){
        await cleanHealth();let options,stream,uploadToken;
        if(req.headers['content-type']?.startsWith('application/json')){
          options=await body(req);uploadToken=options?.uploadToken;const upload=healthUploads.get(uploadToken);if(!upload)return send(410,{error:'上传文件已过期，请重新选择 XML'});
          if(!Array.isArray(options.types)||!options.types.length)bad('请至少选择一种支持的健康指标');stream=appleHealthUploadStream(upload.path,{zip:upload.zip});
        }else{
          if(!req.headers['content-type']?.startsWith('application/xml'))bad('请选择苹果健康导出的 export.xml 文件');options={from:url.searchParams.get('from'),to:url.searchParams.get('to')};
          if(Number(req.headers['content-length']||0)>MAX_HEALTH_BYTES)return send(413,{error:'健康 XML 超过 2 GB 限制'});
          async function* limited(){let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>MAX_HEALTH_BYTES)throw Object.assign(Error('健康 XML 超过 2 GB 限制'),{status:413});yield chunk;}}stream=limited();
        }
        const from=validDate(options.from||dateKey(new Date(Date.now()-364*86400000))),to=validDate(options.to||dateKey(new Date()));if(from>to||(Date.parse(to)-Date.parse(from))/86400000>=3660)bad('健康导入范围需为 1–3660 天');
        let parsed;try{parsed=await parseAppleHealthStream(stream,{from,to,...(options.types?{types:options.types}:{})});}catch(e){if(uploadToken)await dropHealthUpload(uploadToken);e.status=e.status||400;throw e;}
        if(uploadToken&&!healthUploads.has(uploadToken))return send(410,{error:'本次上传已取消或已清理，请重新上传'});
        let records;try{records=parsed.records.map(row=>normalizeWellness({...row,...(row.healthMetrics?{healthMetrics:row.healthMetrics.map(m=>({...m,provider:'Apple Health'}))}:{})}));}catch(e){if(uploadToken)await dropHealthUpload(uploadToken);throw e;}const snapshots=new Map(),counts={fillFields:0,updateFields:0,protectedFields:0,unchangedFields:0,conflictFields:0};
        for(const row of records){const prior=db.prepare('SELECT data FROM wellness WHERE id=?').get(row.date)?.data||null;snapshots.set(row.date,prior);const stored=prior?JSON.parse(prior):{};for(const key of healthKeys)if(Number.isFinite(row[key])){const kind=healthClass(stored,row,key);counts[kind+'Fields']++;if(Number.isFinite(stored[key])&&stored[key]!==row[key])counts.conflictFields++;}const existing=new Map((stored.healthMetrics||[]).map(m=>[m.id,m]));for(const metric of row.healthMetrics||[]){const old=existing.get(metric.id),kind=healthMetricClass(old,metric);counts[kind+'Fields']++;if(old&&old.value!==metric.value)counts.conflictFields++;}}
        if(res.destroyed){if(uploadToken)await dropHealthUpload(uploadToken);return;}if(healthPreviews.size>=4)healthPreviews.delete(healthPreviews.keys().next().value);const token=randomUUID();healthPreviews.set(token,{records,snapshots,uploadToken,from,to,types:options.types||healthKeys,expires:Date.now()+healthPreviewTtlMs});
        return send(200,{token,uploadToken,from,to,records,summary:parsed.summary,sources:parsed.sources,...counts,days:records.length});
      }
      if(path==='/api/wellness/apple-health/commit'&&method==='POST'){
        await cleanHealth();const input=await body(req),preview=healthPreviews.get(input?.token);if(!preview||preview.expires<Date.now())return send(410,{error:'健康导入预览已过期，请重新选择 XML'});
        if(input.overwrite!==undefined&&typeof input.overwrite!=='boolean')bad('覆盖选项必须为布尔值');
        for(const [date,prior]of preview.snapshots)if((db.prepare('SELECT data FROM wellness WHERE id=?').get(date)?.data||null)!==prior){healthPreviews.delete(input.token);if(preview.uploadToken)await dropHealthUpload(preview.uploadToken);return send(409,{error:'预览后健康记录发生变化，请重新上传预览；未写入任何记录'});}
        let fields=0,days=0;const importedAt=new Date().toISOString(),updates=[],counts={fillFields:0,updateFields:0,protectedFields:0,unchangedFields:0};
        for(const row of preview.records){const prior=preview.snapshots.get(row.date),stored=prior?JSON.parse(prior):{date:row.date,notes:''},next={...stored,sources:{...stored.sources}};let changed=false;
          for(const key of healthKeys)if(Number.isFinite(row[key])){const kind=healthClass(stored,row,key);counts[kind+'Fields']++;if(kind==='fill'||kind==='update'||kind==='protected'&&input.overwrite===true){next[key]=row[key];if(row.sources?.[key])next.sources[key]={...row.sources[key],importedAt};else delete next.sources[key];fields++;changed=true;}else if(kind==='unchanged'&&stored.sources?.[key]?.provider==='Apple Health'){
            const old=stored.sources[key].coverage,fresh=row.sources?.[key]?.coverage;
            if(fresh&&(!old||fresh.sampleCount>=old.sampleCount&&fresh.start<=old.start&&fresh.end>=old.end)&&(JSON.stringify(old)!==JSON.stringify(fresh))){next.sources[key]={...row.sources[key],importedAt};changed=true;}
          }}
          const metrics=new Map((stored.healthMetrics||[]).map(m=>[m.id,m]));
          for(const metric of row.healthMetrics||[]){const old=metrics.get(metric.id),kind=healthMetricClass(old,metric);counts[kind+'Fields']++;
            if(kind==='fill'||kind==='update'||kind==='protected'&&input.overwrite===true){metrics.set(metric.id,{...metric,provider:'Apple Health',importedAt});fields++;changed=true;}
            else if(kind==='unchanged'&&old.provider==='Apple Health'&&fullerMetric(old,metric)){
              const fresh={...metric,provider:'Apple Health',importedAt:old.importedAt};if(JSON.stringify(old)!==JSON.stringify(fresh)){metrics.set(metric.id,fresh);changed=true;}
            }
          }
          if(metrics.size)next.healthMetrics=[...metrics.values()].sort((a,b)=>a.id.localeCompare(b.id));
          if(changed){updates.push(normalizeWellness(next));days++;}
        }
        const history={id:randomUUID(),importedAt,from:preview.from,to:preview.to,types:preview.types,days,fields,...counts};
        transaction(()=>{updates.forEach(row=>put('wellness',row.date,row));put('health_imports',history.id,history);const old=all('health_imports').sort((a,b)=>b.importedAt.localeCompare(a.importedAt)).slice(100);old.forEach(row=>db.prepare('DELETE FROM health_imports WHERE id=?').run(row.id));});healthPreviews.delete(input.token);if(preview.uploadToken)await dropHealthUpload(preview.uploadToken);return send(200,{ok:true,days,fields,...counts,activitiesCreated:0});
      }
      if (path === '/api/wellness') {
        if (method === 'GET') return send(200, all('wellness').sort((a,b) => a.date.localeCompare(b.date)));
        if (method === 'POST' || method === 'PUT') {
          const input=await body(req),w=normalizeWellness({...input,sources:undefined,...(Array.isArray(input?.healthMetrics)?{healthMetrics:input.healthMetrics.map(m=>({...m,provider:undefined,importedAt:undefined}))}:{})}),prior=db.prepare('SELECT data FROM wellness WHERE id=?').get(w.date);
          if(prior){const stored=JSON.parse(prior.data);for(const key of healthKeys)if(w[key]!==undefined&&w[key]===stored[key]&&stored.sources?.[key]){w.sources||={};w.sources[key]=stored.sources[key];}
            const metrics=new Map((stored.healthMetrics||[]).map(m=>[m.id,m]));for(const metric of w.healthMetrics||[]){const old=metrics.get(metric.id);metrics.set(metric.id,old&&old.value===metric.value?old:metric);}if(metrics.size)w.healthMetrics=[...metrics.values()].sort((a,b)=>a.id.localeCompare(b.id));
          }put('wellness',w.date,w);return send(200,w);
        }
      }
      if (path === '/api/fitness' && method === 'GET') {
        const to = validDate(url.searchParams.get('to') || dateKey(new Date()));
        const from = validDate(url.searchParams.get('from') || dateKey(new Date(Date.parse(to) - 90 * 86400000)));
        if (from > to || (Date.parse(to) - Date.parse(from)) / 86400000 > 3660) bad('日期范围需为 0–3660 天');
        return send(200, fitness(all('activities'),getSettings(),from,to));
      }
      if(path==='/api/power'&&method==='GET'){
        const from=url.searchParams.has('from')?validDate(url.searchParams.get('from')):'1900-01-01',to=url.searchParams.has('to')?validDate(url.searchParams.get('to')):'2200-12-31';
        if(from>to)bad('起始日期不能晚于结束日期');const type=url.searchParams.get('type');if(type&&!types.has(type))bad('运动类型无效');
        const activities=all('activities').filter(a=>a.date>=from&&a.date<=to&&(!type||a.type===type)),settings=getSettings(),result=powerAnalysis(activities,settings),cyclingCurve=powerAnalysis(activities.filter(a=>a.type==='Ride'&&!a.demo),settings).curve;
        return send(200,{...result,cyclingCurve,estimateActivities:activities.filter(a=>a.type==='Ride'&&!a.demo&&!a.planned).map(a=>({id:a.id,date:a.date,name:a.name})).sort((a,b)=>b.date.localeCompare(a.date)||a.id.localeCompare(b.id))});
      }
      if (path === '/api/backup' && method === 'GET') return send(200,{ version:1, exportedAt:new Date().toISOString(), settings:getSettings(), activities:all('activities'), workouts:all('workouts'), plans:all('plans'), gear:all('gear'), goals:all('goals'), wellness:all('wellness'), healthImports:healthHistory(), imports:db.prepare('SELECT hash,filename FROM imports').all() });
      if (path === '/api/restore' && method === 'POST') {
        const backup = await body(req,256*1024*1024);
        if (backup?.version !== 1 || !Array.isArray(backup.activities) || !Array.isArray(backup.workouts) || !Array.isArray(backup.wellness || []) || (backup.wellness||[]).length>100000 || !backup.settings || backup.activities.length > 20000 || backup.workouts.length > 5000 || !Array.isArray(backup.imports || [])) bad('备份格式或版本无效');
        const settings = normalizeSettings(backup.settings);
        const activities = backup.activities.map(a => normalizeActivity(a,str(a.id,'ID',100) || randomUUID()));
        if(!Array.isArray(backup.plans===undefined?[]:backup.plans)||(backup.plans||[]).length>5000)bad('备份周期计划无效');
        const plans=(backup.plans||[]).map(p=>normalizePlan(p,str(p.id,'计划 ID',100)||randomUUID()));
        validatePlanningLinks(activities);
        for(const key of ['gear','goals'])if(!Array.isArray(backup[key]===undefined?[]:backup[key])||(backup[key]||[]).length>5000)bad('备份器材或目标格式无效');
        const gear=(backup.gear||[]).map(g=>normalizeGear(g,str(g.id,'器材 ID',100)||randomUUID())),goals=(backup.goals||[]).map(g=>normalizeGoal(g,str(g.id,'目标 ID',100)||randomUUID()));
        validateWorkspace(activities,gear,goals);
        const workouts = backup.workouts.map(a => normalizeActivity(a,str(a.id,'ID',100) || randomUUID(),true));
        for (const list of [activities,workouts,plans,gear,goals]) if (new Set(list.map(a=>a.id)).size !== list.length) bad('备份包含重复 ID');
        const wellness = (backup.wellness || []).map(normalizeWellness);if(new Set(wellness.map(w=>w.date)).size!==wellness.length)bad('备份包含重复健康日期');
        if(!Array.isArray(backup.healthImports||[])||(backup.healthImports||[]).length>100)bad('健康导入历史无效');
        const healthImports=(backup.healthImports||[]).map(h=>{if(!h||typeof h.importedAt!=='string'||!Number.isFinite(Date.parse(h.importedAt))||!Array.isArray(h.types)||h.types.length>2000||h.types.some(k=>typeof k!=='string'||k.length>250))bad('健康导入历史无效');const r={id:str(h.id,'健康导入 ID',100)||randomUUID(),importedAt:h.importedAt,from:validDate(h.from),to:validDate(h.to),types:h.types};for(const k of ['days','fields','fillFields','updateFields','protectedFields','unchangedFields'])r[k]=finite(h[k],k,0,100000000);return r;});
        const imports = (backup.imports || []).map(i => { if (!/^[a-f0-9]{64}$/.test(i.hash)) bad('导入摘要无效'); return { hash:i.hash,filename:str(i.filename,'文件名',255) }; });
        transaction(() => { for (const table of ['activities','workouts','plans','gear','goals','wellness','imports','health_imports']) db.exec(`DELETE FROM ${table}`); put('settings',1,settings); activities.forEach(a=>put('activities',a.id,a)); workouts.forEach(a=>put('workouts',a.id,a)); plans.forEach(p=>put('plans',p.id,p)); gear.forEach(g=>put('gear',g.id,g)); goals.forEach(g=>put('goals',g.id,g)); wellness.forEach(w=>put('wellness',w.date,w)); healthImports.forEach(h=>put('health_imports',h.id,h)); imports.forEach(i=>db.prepare('INSERT OR IGNORE INTO imports(hash,filename) VALUES (?,?)').run(i.hash,i.filename)); });
        return send(200,{ok:true});
      }
      if (path === '/api/import' && method === 'POST') {
        const input = await body(req); if (!input || typeof input !== 'object') bad('导入参数无效'); const filename = str(input.filename,'文件名',255), content = str(input.content,'文件内容',40*1024*1024);
        if(input.enrichExisting!==undefined&&typeof input.enrichExisting!=='boolean')bad('enrichExisting 必须为布尔值');
        if (!/^[A-Za-z0-9+/\r\n]*={0,2}$/.test(content)) bad('文件内容必须为 base64');
        const buffer = Buffer.from(content,'base64'); if (!buffer.length) bad('文件为空');
        const hash = createHash('sha256').update(buffer).digest('hex');
        const duplicate=db.prepare('SELECT hash FROM imports WHERE hash=?').get(hash);
        if(input.enrichExisting&&(!duplicate||!/^.*\.fit$/i.test(filename)))bad('仅可补充已经导入的同一 FIT 文件');
        let activities;
        try { activities = importFile(filename,buffer,getSettings()).map(a=>normalizeActivity(a)); } catch(e) { e.status = 400; throw e; }
        if(input.enrichExisting){
          // Old versions kept only a file hash registry. Their records are
          // matched only when every original base sample matches uniquely.
          // Names, dates and user associations are deliberately not identifiers.
          const baseKeys=['time','power','hr','cadence','altitude','speed','distance','lat','lon','timerActive'];
          const fingerprint=a=>createHash('sha256').update(JSON.stringify((a.streams||[]).map(s=>Object.fromEntries(baseKeys.filter(k=>s[k]!==undefined).map(k=>[k,s[k]]))))).digest('hex');
          const stored=all('activities'),tagged=stored.filter(a=>a.importHash===hash),used=new Set(),enriched=[];
          const signatures=new Map(stored.map(a=>[a.id,fingerprint(a)]));
          if(tagged.length&&tagged.length!==activities.length)bad('原 FIT 活动段数量已变化，不能安全补充详情');
          for(let index=0;index<activities.length;index++){
            const fresh=activities[index],signature=fingerprint(fresh);
            const candidates=(tagged.length?tagged.filter(a=>a.importSessionIndex===index):stored.filter(a=>!a.importHash)).filter(a=>!used.has(a.id)&&signatures.get(a.id)===signature);
            if(candidates.length!==1)bad('找不到唯一且采样一致的原 FIT 活动，未修改任何记录');
            const prior=candidates[0];used.add(prior.id);
            const streams=prior.streams.map((s,i)=>{const row={...s};for(const key of ['temperature','grade','balance'])if(row[key]===undefined&&fresh.streams[i][key]!==undefined)row[key]=fresh.streams[i][key];return row;});
            enriched.push(normalizeActivity({...prior,streams,fitSummary:{...fresh.fitSummary,...prior.fitSummary},fitDevices:prior.fitDevices?.length?prior.fitDevices:fresh.fitDevices,importHash:hash,importSessionIndex:index},prior.id));
          }
          transaction(()=>enriched.forEach(a=>put('activities',a.id,a)));
          return send(200,{ok:true,enriched:true,count:enriched.length,activities:enriched});
        }
        const stored=all('activities'),tagged=stored.filter(a=>a.importHash===hash),used=new Set();let retained=0;
        if(duplicate){const signatures=new Map();for(const fresh of activities){const signature=importSignature(fresh);signatures.set(signature,(signatures.get(signature)||0)+1);}for(const [signature,count]of signatures)if(count>1){const legacy=stored.filter(a=>!a.importHash&&importSignature(a)===signature).length,known=tagged.filter(a=>importSignature(a)===signature).length;if(legacy>0&&legacy+known<count)return send(409,{error:'旧版文件中部分活动已删除，剩余活动采样完全相同，无法安全识别需要恢复的活动段；未修改任何记录',code:'AMBIGUOUS_IMPORT'});}}
        activities=activities.flatMap((fresh,index)=>{
          const signature=importSignature(fresh),existing=tagged.find(a=>!used.has(a.id)&&(a.importSessionIndex===index||a.importSessionIndex===undefined&&importSignature(a)===signature))||((duplicate||tagged.length)?stored.find(a=>!a.importHash&&!used.has(a.id)&&importSignature(a)===signature):null);
          if(existing){used.add(existing.id);retained++;return [];}
          return [{...fresh,importHash:hash,importSessionIndex:index}];
        });
        if(!activities.length)return send(409,{error:'此文件对应的活动仍然存在，未重复添加',code:'DUPLICATE_IMPORT'});
        transaction(()=>{ activities.forEach(a=>put('activities',a.id,a)); db.prepare('INSERT OR REPLACE INTO imports(hash,filename) VALUES (?,?)').run(hash,filename); });
        return send(201,{ok:true,count:activities.length,activities,retained,message:retained?`已恢复 ${activities.length} 条已删除活动，保留 ${retained} 条现存活动及其编辑`:`导入完成 · ${activities.length} 条活动`});
      }
      if (path === '/api/demo' && method === 'DELETE') {
        transaction(() => {
          for (const table of ['activities', 'workouts']) {
            const remove = db.prepare(`DELETE FROM ${table} WHERE id=?`);
            for (const row of all(table)) if (row.demo === true) remove.run(row.id);
          }
        });
        const remaining=all('activities'),ids=new Set(remaining.map(a=>a.id));for(const a of remaining)if(a.completionId&&!ids.has(a.completionId)){delete a.completionId;put('activities',a.id,a);}
        for(const goal of all('goals'))if(goal.activityId&&!ids.has(goal.activityId)){delete goal.activityId;put('goals',goal.id,goal);}
        return send(200, { ok: true });
      }
      if (path === '/api/demo' && method === 'POST') {
        await body(req);
        const existing = all('activities').some(a=>a.demo); if (existing) return send(409,{error:'示例数据已载入'});
        transaction(()=>{
          for (let i=0; i<42; i++) {
            const date=dateKey(new Date(Date.UTC(2026,9,12+i)));
            if (i%7===0 || i%7===4) continue;
            const planned = date > '2026-11-09', duration = 45 + (i%5)*15, power = 135 + (i%4)*25;
            const intervals = i%3===0 ? [{duration:10,power:55},{duration:8,power:105},{duration:4,power:50},{duration:8,power:105},{duration:10,power:55}] : [{duration,power:power/250*100}];
            const streams = planned ? [] : Array.from({length:Math.floor(duration*60/5)+1},(_,j)=>({time:j*5,power:Math.round(power+25*Math.sin(j/18)+10*Math.sin(j*1.9)),hr:Math.round(125+(power-135)*.3+8*Math.sin(j/25)),cadence:Math.round(85+8*Math.sin(j/20)),altitude:Math.round(20+12*Math.sin(j/30)),distance:j*5*7.5}));
            const a = normalizeActivity({name:['有氧耐力骑行','节奏训练','轻松恢复骑行','阈值间歇'][i%4]+' · 示例',type:i%9===0?'Run':'Ride',date,duration,distance:duration*(i%9===0?.15:.48),load:Math.round(duration/60*(power/250)**2*100),power,hr:Math.round(125+(power-135)*.3),planned,intervals,streams,demo:true,notes:'训练日历示例。'}); put('activities',a.id,a);
          }
          const stages=[{duration:600,power:150},...Array.from({length:4},()=>[{duration:300,power:275},{duration:180,power:130}]).flat(),{duration:480,power:110}];
          const boundaries=[];let elapsed=0;for(const step of stages){boundaries.push({start:elapsed,end:elapsed+step.duration,power:step.power});elapsed+=step.duration;}
          const samples=Array.from({length:elapsed+1},(_,time)=>{const step=boundaries.find(b=>time>=b.start&&time<b.end)||boundaries.at(-1);return {time,power:step.power,hr:Math.round(110+step.power*.15+time/elapsed*8),cadence:88,altitude:30+15*Math.sin(time/400),distance:time*7.5,lat:31.2+.025*Math.sin(time/elapsed*2*Math.PI),lon:121.45+.04*Math.cos(time/elapsed*2*Math.PI)};});
          const analysisDemo=normalizeActivity({name:'4 × 5 分钟 · 分析示例',type:'Ride',date:'2026-11-08',duration:elapsed/60,distance:elapsed*7.5/1000,load:65,power:190,hr:145,streams:samples,laps:boundaries.map((b,i)=>({start:b.start,end:b.end,label:'设备圈 '+(i+1)})),analysisMode:'auto',demo:true,notes:'4 组阈值间歇 · 自动分段、设备圈、最佳努力与轨迹分析示例。'});put('activities',analysisDemo.id,analysisDemo);
          for (const [name,intervals] of [['有氧耐力 Z2',[{duration:10,power:50},{duration:50,power:68},{duration:10,power:50}]],['4 × 8 分钟阈值',[{duration:15,power:55},...Array.from({length:4},()=>[{duration:8,power:100},{duration:4,power:50}]).flat(),{duration:10,power:45}]],['恢复骑行',[{duration:45,power:50}]]]) {
            const duration=intervals.reduce((n,s)=>n+s.duration,0); const a=normalizeActivity({name,type:'Ride',duration,load:Math.round(intervals.reduce((n,s)=>n+s.duration/60*(s.power/100)**2*100,0)),intervals,demo:true,description:'本地示例模板，可编辑并安排到日历。'},randomUUID(),true); put('workouts',a.id,a);
          }
        });
        return send(200,{ok:true});
      }
      if (path.startsWith('/api/')) return send(404,{error:'接口不存在或请求方法不支持'});
      if (method !== 'GET' && method !== 'HEAD') return send(405,{error:'请求方法不支持'});
      const files = {'/':'index.html','/index.html':'index.html','/app.js':'app.js','/apple-health-tools.js':'apple-health-tools.js','/weather.mjs':'weather.mjs','/weather-view.js':'weather-view.js','/performance-estimates.mjs':'performance-estimates.mjs','/elevation.mjs':'elevation.mjs','/chart-zoom.js':'chart-zoom.js','/chart-series.mjs':'chart-series.mjs','/settings.mjs':'settings.mjs','/activity-tools.js':'activity-tools.js','/activity-overview.js':'activity-overview.js','/activity-detail.css':'activity-detail.css','/ride-details.mjs':'ride-details.mjs','/ride-breakdown.mjs':'ride-breakdown.mjs','/ride-insights.js':'ride-insights.js','/route-map.js':'route-map.js','/route-map.css':'route-map.css','/route-geometry.mjs':'route-geometry.mjs','/planning-tools.js':'planning-tools.js','/workout.mjs':'workout.mjs','/workout-builder.js':'workout-builder.js','/wellness-trends.js':'wellness-trends.js','/wellness-trends.mjs':'wellness-trends.mjs','/workspace-tools.js':'workspace-tools.js','/styles.css':'styles.css','/favicon.svg':'favicon.svg'};
      if (!files[path]) return send(404,{error:'文件不存在'});
      const file=files[path], content=await readFile(join(root,file));
      res.writeHead(200,{'Content-Type':file.endsWith('.html')?'text/html; charset=utf-8':(file.endsWith('.js')||file.endsWith('.mjs'))?'text/javascript; charset=utf-8':file.endsWith('.svg')?'image/svg+xml':'text/css; charset=utf-8','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",'X-Content-Type-Options':'nosniff'}); res.end(method==='HEAD'?undefined:content);
    } catch (error) { send(error.status || 500,{error:error.status ? error.message : '本地服务处理失败，请重试'}); if (!error.status) console.error(error); }
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>{address=server.address();resolve();});});
  return { url:`http://127.0.0.1:${address.port}`, close:()=>new Promise((resolve,reject)=>{server.close(async error=>{clearInterval(healthTimer);try{await rm(healthStaging,{recursive:true,force:true});db.close();error?reject(error):resolve();}catch(e){reject(e);}});server.closeIdleConnections();}) };
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const instance=await startServer({port:Number(process.env.PORT || 4173),dataDir:process.env.CYCLE_DATA_DIR || undefined});
  console.log(`Cycle Local: ${instance.url}`);
  for (const signal of ['SIGTERM','SIGINT']) process.once(signal,async()=>{await instance.close();process.exit(0);});
}
