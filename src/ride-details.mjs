import {elevationActivity} from './elevation.mjs';
// Shared FIT metadata validation and descriptive riding statistics. SI units are
// retained in storage; only the presentation metrics convert speed to km/h.
const finite = n => typeof n === 'number' && Number.isFinite(n);
const invalid = message => Object.assign(Error(message),{status:400});
export const FIT_SUMMARY_FIELDS = {
  elapsedSeconds:[0,129600],timerSeconds:[0,129600],movingSeconds:[0,129600],
  distance:[0,10000000],avgSpeed:[0,100],maxSpeed:[0,100],ascent:[0,100000],descent:[0,100000],
  minAltitude:[-500,20000],maxAltitude:[-500,20000],avgPower:[0,5000],maxPower:[0,5000],
  avgHr:[0,300],maxHr:[0,300],avgCadence:[0,300],maxCadence:[0,300],
  avgTemperature:[-100,100],minTemperature:[-100,100],maxTemperature:[-100,100],
  calories:[0,100000],aerobicEffect:[0,5],anaerobicEffect:[0,5],avgBalance:[0,100],
  workKj:[0,1000000],normalizedPower:[0,5000],trainingStressScore:[0,10000],intensityFactor:[0,10]
};
export function normalizeFitSummary(input) {
  if(!input||typeof input!=='object'||Array.isArray(input))throw invalid('FIT 汇总必须为对象');
  const result={};
  for(const [key,[min,max]] of Object.entries(FIT_SUMMARY_FIELDS)) {
    if(input[key]===undefined)continue;
    if(!finite(input[key])||input[key]<min||input[key]>max)throw invalid(`FIT ${key} 必须在 ${min}–${max} 范围内`);
    result[key]=input[key];
  }
  if(input.startedAt!==undefined){if(typeof input.startedAt!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(input.startedAt)||!finite(Date.parse(input.startedAt))||new Date(input.startedAt).toISOString()!==input.startedAt)throw invalid('FIT 开始时间无效');result.startedAt=input.startedAt;}
  if(result.timerSeconds>result.elapsedSeconds||result.movingSeconds>result.elapsedSeconds)throw invalid('FIT 计时或移动时间不能超过经过时间');
  return result;
}
export function normalizeFitDevices(input) {
  if(!Array.isArray(input)||input.length>50)throw invalid('FIT 设备必须为最多 50 项的数组');
  return input.map(item=>{
    if(!item||typeof item!=='object'||Array.isArray(item))throw invalid('FIT 设备格式无效');
    const row={};
    for(const key of ['name','manufacturer','product','softwareVersion','type'])if(item[key]!==undefined){if(typeof item[key]!=='string'||item[key].length>150)throw invalid('FIT 设备字段必须为不超过 150 字符的文本');row[key]=item[key];}
    return row;
  });
}

const validCoordinate = r => finite(r?.lat)&&finite(r?.lon)&&Math.abs(r.lat)<=90&&Math.abs(r.lon)<=180;
const earthDistance = (a,b) => {
  const rad=Math.PI/180,lat=(b.lat-a.lat)*rad,lon=(b.lon-a.lon)*rad;
  const h=Math.sin(lat/2)**2+Math.cos(a.lat*rad)*Math.cos(b.lat*rad)*Math.sin(lon/2)**2;
  return 6371008.8*2*Math.atan2(Math.sqrt(Math.max(0,h)),Math.sqrt(Math.max(0,1-h)));
};

/** Adjacent distance, then GPS, may supply missing speed. Counter resets,
 * timer stops and gaps never become inferred speed; stored records stay intact. */
export function rideSpeedStreams(activity={}) {
  const rows=activity.streams||[];
  return rows.map((row,i)=>{
    const out={...row},next=rows[i+1],dt=next?next.time-row.time:0;
    if(row.timerActive===false){delete out.speed;delete out.speedSource;return out;}
    if(finite(row.speed)&&row.speed>=0&&row.speed<=100){out.speedSource=['recorded','distance','gps'].includes(row.speedSource)?row.speedSource:'recorded';return out;}
    delete out.speed;delete out.speedSource;
    if(!next||(next.timerActive===false&&row.timerActive!==true)||dt<=0||dt>30)return out;
    const counterPair=finite(row.distance)&&finite(next.distance);
    // A counter reset is an explicit discontinuity, even when GPS is present.
    if(counterPair&&next.distance<row.distance)return out;
    const distance=counterPair?next.distance-row.distance:validCoordinate(row)&&validCoordinate(next)?earthDistance(row,next):null;
    const speed=distance===null?null:distance/dt;
    if(finite(speed)&&speed>=0&&speed<=100){out.speed=speed;out.speedSource=counterPair?'distance':'gps';}
    return out;
  });
}

const MISSING={
  timerSeconds:'缺少设备计时汇总或覆盖全程的计时状态，无法确认全部暂停时段。',
  pausedSeconds:'需要可靠的经过时间和计时时间，不能把采样缺口当作暂停。',
  movingSeconds:'需要速度、累计距离或可计算速度的 GPS 采样。',
  movingAvgSpeed:'没有速度大于 1.8 km/h 的有效移动采样。',
  maxSpeed:'没有有效速度、相邻累计距离或 GPS 坐标，平均速度无法推回峰值。',
  speedP95:'没有带有效持续时间的速度采样。',
  avgPower:'文件没有功率采样或已保存平均功率，不能从心率或速度还原。',
  maxPower:'没有功率采样或设备最大功率，平均功率无法推回峰值。',
  workKj:'需要有效功率采样积分或设备机械功汇总。',
  calories:'没有设备热量，且有效功率覆盖不足 95%，不估算整次活动热量。',
  caloriesLow:'仅在缺少设备热量且有效功率覆盖达到 95% 时估算。',
  caloriesHigh:'仅在缺少设备热量且有效功率覆盖达到 95% 时估算。',
  observedCalories:'没有带有效持续时间的功率采样，无法估算已记录路段能耗。',
  observedCaloriesLow:'没有带有效持续时间的功率采样，无法估算已记录路段能耗。',
  observedCaloriesHigh:'没有带有效持续时间的功率采样，无法估算已记录路段能耗。',
  aerobicEffect:'设备未提供有氧训练效果；这是厂商模型输出，无法从现有采样可靠重建。',
  anaerobicEffect:'设备未提供无氧训练效果；这是厂商模型输出，无法从现有采样可靠重建。',
  balance:'未记录左右功率；单侧或总功率不能推算左右平衡。',
  avgTemperature:'没有温度传感器采样或设备温度汇总，不能由速度/海拔推算。',
  minTemperature:'没有温度采样，均温不能推回最低温度。',
  maxTemperature:'没有温度采样，均温不能推回最高温度。',
  avgTorqueNm:'需要同一时段的功率与大于零的踏频。',
  powerPerKg:'需要平均功率和设置中的有效体重。',
  hrPercentMax:'需要平均心率和设置中的有效最大心率。',
  coastingSeconds:'需要同一时段的移动速度和功率，缺测不当作零功率。',
  pedalingSeconds:'需要有效踏频或功率采样。',
  stoppedSeconds:'需要有效速度采样，采样缺口不当作停车。',
  avgMovingPower:'需要同一时段的移动速度和功率。',
  avgPedalingCadence:'没有大于零且有有效持续时间的踏频采样。',
  cadenceRevolutions:'需要有有效持续时间的踏频采样。',
  avgHr:'没有心率采样或设备/已保存均值。',
  maxHr:'没有心率采样或设备极值。',
  avgCadence:'没有踏频采样或设备均值。',
  maxCadence:'没有踏频采样或设备极值。',
  ascent:'需要设备爬升或相邻有效海拔，单一海拔值不能计算爬升。',
  descent:'需要设备下降或相邻有效海拔，单一海拔值不能计算下降。',
  minAltitude:'没有海拔采样或设备海拔汇总。',
  maxAltitude:'没有海拔采样或设备海拔汇总。'
};

/** Descriptive statistics. Device summaries remain authoritative; every fallback
 * exposes its provenance, assumptions and observation boundary to the UI. */
export function rideDetails(activity={},settings={}) {
  activity=elevationActivity(activity);
  const summary=activity.fitSummary||{};
  const changes=new Map((activity.powerCorrections||[]).map(c=>[c.time,c.power]));
  const rows=rideSpeedStreams(activity).map(r=>{
    if(!changes.has(r.time))return r;
    const out={...r};if(changes.get(r.time)===null)delete out.power;else out.power=changes.get(r.time);return out;
  });
  const active=rows.filter(r=>r.timerActive!==false),metrics={},coverage={};
  const set=(key,value,unit='',source=null,extra={})=>{
    const known=finite(value);metrics[key]={value:known?value:null,unit,source:known?source:null,...extra};
    if(!known&&!metrics[key].missingReason)metrics[key].missingReason=MISSING[key]||'文件未提供此汇总，现有采样也不足以计算。';
  };
  const device=(key,fallback,unit='',factor=1)=>{
    const value=summary[key];
    if(finite(value))set(key,value*factor,unit,'device');
    else set(key,fallback?.value,unit,fallback?.source,fallback?.note?{note:fallback.note}:{});
  };
  const spans=[];
  for(let i=0;i+1<rows.length;i++){
    const r=rows[i],n=rows[i+1],dt=n.time-r.time;
    if(r.timerActive!==false&&dt>0&&dt<=30)spans.push({r,n,dt});
  }
  function sample(key,mode='avg',predicate=()=>true){
    const values=active.filter(r=>finite(r[key])&&predicate(r)).map(r=>r[key]);
    let sum=0,seconds=0;
    for(const {r,dt} of spans)if(finite(r[key])&&predicate(r)){sum+=r[key]*dt;seconds+=dt;}
    // Coverage always describes this stream, not a filtered subset such as moving.
    if(!Object.hasOwn(coverage,key))coverage[key]=seconds;
    const value=mode==='max'?(values.length?values.reduce((a,b)=>Math.max(a,b),-Infinity):null):mode==='min'?(values.length?values.reduce((a,b)=>Math.min(a,b),Infinity):null):(seconds?sum/seconds:null);
    return {value,source:'samples',sum,seconds};
  }
  const elapsed=finite(summary.elapsedSeconds)?summary.elapsedSeconds:finite(activity.duration)?activity.duration*60:rows.at(-1)?.time;
  set('elapsedSeconds',elapsed,'s',finite(summary.elapsedSeconds)?'device':finite(activity.duration)?'saved':'samples');
  const observed=spans.reduce((n,s)=>n+s.dt,0);
  set('observedSeconds',rows.length>1?observed:null,'s','samples',{note:'仅累计计时有效且相邻记录间隔不超过 30 秒的已观察时段，不跨缺口。'});
  const explicitTimer=finite(elapsed)&&rows.length>0&&rows[0].time===0&&rows.at(-1).time<=elapsed&&rows.every(r=>typeof r.timerActive==='boolean');
  let timer=0;
  if(explicitTimer){
    // Timer state is a carried event state, not a measurement. It may span a
    // recording gap and extend to the known session end; power never does.
    for(let i=0;i<rows.length;i++)if(rows[i].timerActive){const end=i+1<rows.length?rows[i+1].time:elapsed;timer+=Math.max(0,end-rows[i].time);}
  }
  const complete=rows.length>1&&rows[0].time===0&&rows.at(-1).time===elapsed&&rows.every((r,i)=>!i||r.time-rows[i-1].time>0&&r.time-rows[i-1].time<=30);
  device('timerSeconds',{value:explicitTimer?timer:complete?observed:null,source:explicitTimer?'derived':'samples',note:explicitTimer?'按 FIT 计时状态累计活动时长。':undefined},'s');
  // Older SDK imports saved the rounded device timer in a generated summary.
  // Recover only that known format, and expose it as editable saved metadata.
  const legacyTimer = !finite(summary.timerSeconds) && typeof activity.notes === 'string' && activity.notes.startsWith('FIT 经 Garmin 官方 SDK 解码，文件完整性及 CRC 已校验。')
    ? [...activity.notes.matchAll(/设备计时 (\d+) 秒/g)] : [];
  if(legacyTimer.length===1){
    const value=Number(legacyTimer[0][1]);
    if(value>0&&value<=elapsed)set('timerSeconds',value,'s','saved',{note:'从旧版自动导入摘要恢复的设备计时（取整至秒）；摘要可编辑，建议重新导入原 FIT 核对。'});
  }
  set('pausedSeconds',finite(elapsed)&&finite(metrics.timerSeconds.value)?Math.max(0,elapsed-metrics.timerSeconds.value):null,'s',metrics.timerSeconds.source==='saved'?'saved':'derived',{note:'经过时间减计时时间；不把缺测误算成暂停。'+(metrics.timerSeconds.source==='saved'?' 计时来自旧版已保存摘要，可重新导入 FIT 核对。':'')});
  let stationaryGaps=0;
  for(let i=0;i+1<rows.length;i++){
    const r=rows[i],n=rows[i+1],dt=n.time-r.time;
    const counter=finite(r.distance)&&finite(n.distance)&&n.distance>=r.distance? n.distance-r.distance:null;
    const gps=validCoordinate(r)&&validCoordinate(n)?earthDistance(r,n):null;
    if(dt>30&&r.timerActive!==false&&counter!==null&&counter<=20&&(gps===null||gps<=30))stationaryGaps+=dt;
  }
  set('estimatedPauseSeconds',stationaryGaps||null,'s','estimated',{note:'按超过 30 秒且端点位置基本不变的缺口估算。'});
  const denominator=metrics.timerSeconds.value??elapsed;
  let moving=0,movingDistance=0,speedSeconds=0,stopped=0,powerEnergy=0,powerSeconds=0,cadenceSeconds=0,revolutions=0,coasting=0,coastKnown=0,pedaling=0,pedalKnown=0,movingPower=0,movingPowerSeconds=0,torqueSum=0,torqueSeconds=0;
  const speedWeights=[];
  for(const {r,dt} of spans){
    if(finite(r.speed)){
      speedSeconds+=dt;speedWeights.push([r.speed,dt]);
      if(r.speed>.5){moving+=dt;movingDistance+=r.speed*dt;if(finite(r.power)){movingPower+=r.power*dt;movingPowerSeconds+=dt;}}
      else stopped+=dt;
      if(finite(r.power)){coastKnown+=dt;if(r.speed>.5&&r.power===0)coasting+=dt;}
    }
    if(finite(r.power)){powerEnergy+=r.power*dt;powerSeconds+=dt;}
    if(finite(r.cadence)){cadenceSeconds+=dt;revolutions+=r.cadence*dt/60;}
    if(finite(r.cadence)||finite(r.power)){pedalKnown+=dt;if(r.cadence>0||r.power>0)pedaling+=dt;}
    if(finite(r.power)&&finite(r.cadence)&&r.cadence>0){torqueSum+=r.power/(r.cadence*2*Math.PI/60)*dt;torqueSeconds+=dt;}
  }
  device('movingSeconds',{value:speedSeconds?moving:null,source:'derived',note:'有效速度大于 1.8 km/h 的观察时长，仅统计有效采样覆盖部分。'},'s');
  set('stoppedSeconds',speedSeconds?stopped:null,'s','derived',{note:'有效计时时段内，速度不大于 1.8 km/h 的累计时长。'});
  set('coastingSeconds',coastKnown?coasting:null,'s','derived',{note:'有效时段内速度大于 1.8 km/h，且功率为 0 W。'});
  set('pedalingSeconds',pedalKnown?pedaling:null,'s','derived',{note:'有效时段中踏频大于零或功率大于零；只累计有此类采样的时段。'});
  set('avgMovingPower',movingPowerSeconds?movingPower/movingPowerSeconds:null,'W','samples',{note:'速度大于 1.8 km/h 时的时间加权功率，包含实测零功率。'});
  set('avgPedalingCadence',sample('cadence','avg',r=>r.cadence>0).value,'rpm','samples',{note:'仅大于零的踏频，按有效时长加权。'});
  set('cadenceRevolutions',cadenceSeconds?revolutions:null,'转','derived',{note:'曲柄转数 = 踏频 × 有效秒数 / 60。'});
  set('avgTorqueNm',torqueSeconds?torqueSum/torqueSeconds:null,'N·m','derived',{note:'曲柄扭矩估算：功率 ÷ (踏频 × 2π/60)，按有效时长加权。'});
  let counterDistance=0,counterPairs=0;
  for(const {r,n} of spans)if((n.timerActive!==false||r.timerActive===true)&&finite(r.distance)&&finite(n.distance)&&n.distance>=r.distance){counterDistance+=n.distance-r.distance;counterPairs++;}
  const speedDistance=spans.reduce((n,{r,dt})=>n+(finite(r.speed)?r.speed*dt:0),0);
  if(summary.distance>0)set('distance',summary.distance/1000,'km','device');
  else if(activity.distance>0)set('distance',activity.distance,'km','saved');
  else if(counterPairs)set('distance',counterDistance/1000,'km','derived',{note:'相邻有效累计距离差求和，不跨暂停、缺口或距离计数重置；仅覆盖已观察路段。'});
  else if(speedSeconds)set('distance',speedDistance/1000,'km','derived',{note:'有效速度积分（含由 GPS 推算的速度），只覆盖已观察路段。'});
  else device('distance',{value:finite(activity.distance)?activity.distance:null,source:'saved'},'km',.001);
  const avgSpeed=sample('speed'),maxSpeed=sample('speed','max');
  const inferredSpeed=active.some(r=>r.speedSource==='distance'||r.speedSource==='gps');
  if(inferredSpeed){avgSpeed.source='derived';maxSpeed.source='derived';avgSpeed.note=maxSpeed.note='速度含累计距离差或 GPS 位置差推算，可能受采样间隔与定位误差影响。';}
  if(finite(avgSpeed.value))avgSpeed.value*=3.6;
  else if(metrics.distance.value>0&&metrics.timerSeconds.value>0){avgSpeed.value=metrics.distance.value/metrics.timerSeconds.value*3600;avgSpeed.source='derived';avgSpeed.note='平均速度 = 距离 ÷ 计时时间。';}
  if(finite(maxSpeed.value))maxSpeed.value*=3.6;
  device('avgSpeed',avgSpeed,'km/h',3.6);device('maxSpeed',maxSpeed,'km/h',3.6);
  set('movingAvgSpeed',moving?movingDistance/moving*3.6:null,'km/h','derived',{note:'速度大于 1.8 km/h 的有效采样距离积分 ÷ 对应移动时间。'});
  speedWeights.sort((a,b)=>a[0]-b[0]);let p95=null,weight=0;for(const [speed,dt] of speedWeights){weight+=dt;if(weight>=speedSeconds*.95){p95=speed*3.6;break;}}
  set('speedP95',p95,'km/h',inferredSpeed?'derived':'samples',{note:'按有效秒数加权的第 95 百分位速度，95% 已观察时长的速度不超过此值。'});
  for(const [key,stream,unit] of [['Power','power','W'],['Hr','hr','bpm'],['Cadence','cadence','rpm'],['Temperature','temperature','°C']]){device('avg'+key,sample(stream),unit);device('max'+key,sample(stream,'max'),unit);}
  // Filtered cadence statistics above must not replace full-stream coverage.
  coverage.cadence=cadenceSeconds;
  if(metrics.avgPower.value===null)set('avgPower',activity.power,'W','saved');
  if(metrics.avgHr.value===null)set('avgHr',activity.hr,'bpm','saved');
  device('minTemperature',sample('temperature','min'),'°C');device('minAltitude',sample('altitude','min'),'m');device('maxAltitude',sample('altitude','max'),'m');
  let ascent=0,descent=0,altPairs=0;
  for(const {r,n} of spans){if((n.timerActive===false&&r.timerActive!==true)||!finite(r.altitude)||!finite(n.altitude))continue;const delta=n.altitude-r.altitude;altPairs++;ascent+=Math.max(0,delta);descent+=Math.max(0,-delta);}
  const altitudeNote='累加相邻有效采样的海拔差。';
  device('ascent',{value:altPairs?ascent:null,source:'derived',note:altitudeNote},'m');device('descent',{value:altPairs?descent:null,source:'derived',note:altitudeNote},'m');
  device('workKj',{value:powerSeconds?powerEnergy/1000:null,source:'samples',note:'有效功率积分；应用已保存功率修正，暂停与缺口不积分，可能仅覆盖部分活动。'},'kJ');
  for(const [key,stream] of [['power','power'],['hr','hr'],['speed','speed'],['cadence','cadence']]){
    const seconds=key==='power'?powerSeconds:key==='speed'?speedSeconds:key==='cadence'?cadenceSeconds:sample(stream).seconds;
    coverage[key]=seconds;
    set(key+'CoveragePct',finite(denominator)&&denominator>0?Math.min(100,seconds/denominator*100):null,'%','samples',{note:'有效采样秒数 ÷ 计时时间（无法确认计时时，分母使用经过时间）。'});
  }
  device('calories',null,'kcal');
  const canEstimate=metrics.calories.value===null&&powerSeconds>0&&denominator>0&&powerSeconds/denominator>=.95;
  const kcalNote='能耗估算：机械功 kJ ÷ 4.184 ÷ 总效率 24%；范围按 20%–25% 总效率计算。';
  if(canEstimate)set('calories',powerEnergy/1000/4.184/.24,'kcal','estimated',{note:kcalNote});
  set('caloriesLow',canEstimate?powerEnergy/1000/4.184/.25:null,'kcal','estimated',{note:'按总效率 25% 估算。'});
  set('caloriesHigh',canEstimate?powerEnergy/1000/4.184/.20:null,'kcal','estimated',{note:'按总效率 20% 估算。'});
  const observedCoverage=metrics.powerCoveragePct.value;
  const observedKcalNote=`仅估算已记录的有效功率时段${finite(observedCoverage)?`，覆盖 ${observedCoverage.toFixed(2)}% 的${metrics.timerSeconds.value===null?'经过':'计时'}时间`:''}，不是整次活动热量，不补齐缺测区间。按机械功 kJ ÷ 4.184 ÷ 假定总效率 24%；20%–25% 效率假设范围不是测量置信区间。`;
  set('observedCalories',powerSeconds?powerEnergy/1000/4.184/.24:null,'kcal','estimated',{note:observedKcalNote});
  set('observedCaloriesLow',powerSeconds?powerEnergy/1000/4.184/.25:null,'kcal','estimated',{note:observedKcalNote+' 此下限假定效率为 25%。'});
  set('observedCaloriesHigh',powerSeconds?powerEnergy/1000/4.184/.20:null,'kcal','estimated',{note:observedKcalNote+' 此上限假定效率为 20%。'});
  for(const key of ['aerobicEffect','anaerobicEffect'])device(key,null);
  const balance=sample('balance');set('balance',finite(summary.avgBalance)?summary.avgBalance:balance.value,'%',finite(summary.avgBalance)?'device':balance.source);
  set('powerPerKg',metrics.avgPower.value!==null&&settings.weight>0?metrics.avgPower.value/settings.weight:null,'W/kg','derived',{note:'平均功率 ÷ 当前设置体重。'});
  set('hrPercentMax',metrics.avgHr.value!==null&&settings.maxHr>0?metrics.avgHr.value/settings.maxHr*100:null,'%','derived',{note:'平均心率 ÷ 当前设置最大心率。'});
  if(activity.elevationCorrection)for(const key of ['ascent','descent','minAltitude','maxAltitude'])if(finite(metrics[key]?.value)){metrics[key].source='derived';metrics[key].note='由路线地形高程计算，分辨率约 30–40 m。';}
  const speedTypes=new Set(active.filter(r=>finite(r.speed)).map(r=>r.speedSource));
  return {metrics,coverage,speedSource:speedTypes.size>1?'mixed':speedTypes.values().next().value||null,startedAt:activity.startedAt||summary.startedAt||null,devices:activity.fitDevices||[],notes:[
    '设备汇总优先；无设备值时按有效采样补算，均值按时间加权。功率与心率等测量不跨超过 30 秒的缺口，最后一点不外推。计时状态可延续至已知结束时间。',
    '速度以 km/h 显示；依次使用实测速度、相邻累计距离差、相邻 GPS 位置差。移动阈值为 1.8 km/h，GPS 推算可能受定位误差影响。',
    '机械功由有效功率积分；缺设备热量且功率覆盖至少 95% 时，按总效率 24% 估算热量并标明假设范围。训练效果、左右平衡和温度缺少相应数据时不虚构。',
    '爬升/下降累加相邻海拔差，未平滑；所有观察时长、转数与采样推算值均不补齐缺测路段。'
  ]};
}
