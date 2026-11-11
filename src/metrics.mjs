import { effectiveStreams,resampleActivity } from './analysis.mjs';
import { analysisDefaults, resolveFtp } from './settings.mjs';
export const defaults = { name: '本地运动员', ftp: 250, weight: 70, maxHr: 190, restHr: 55, ctlDays: 42, atlDays: 7, initialCtl: 0, initialAtl: 0, ...analysisDefaults };
export const dateKey = date => new Date(date).toISOString().slice(0, 10);
export function fitness(activities, settings, from, to) {
  const completed = activities.filter(a => !a.planned);
  const earliest = completed.map(a => a.date).sort()[0];
  const start = earliest && earliest < from ? earliest : from;
  const loads = new Map();
  for (const a of completed) loads.set(a.date, (loads.get(a.date) || 0) + a.load);
  let ctl = settings.initialCtl, atl = settings.initialAtl;
  const result = [];
  for (let day = new Date(start + 'T00:00:00Z'); dateKey(day) <= to; day.setUTCDate(day.getUTCDate() + 1)) {
    const date = dateKey(day), load = loads.get(date) || 0, tsb = ctl - atl;
    ctl += (load - ctl) * (1 - Math.exp(-1 / settings.ctlDays));
    atl += (load - atl) * (1 - Math.exp(-1 / settings.atlDays));
    if (date >= from) result.push({ date, load, ctl, atl, tsb });
  }
  return result;
}
export function powerAnalysis(activities,settings){
  const durations=[1,5,10,15,30,60,120,180,300,600,1200,1800,3600,7200],best=new Map();
  const bounds=[.55,.75,.9,1.05,1.2,1.5,Infinity],colors=['#94a3b8','#438ec8','#48ad75','#e7bb35','#f18c3e','#dc6275','#9a68bf'];
  const zones=bounds.map((_,i)=>({name:'Z'+(i+1),seconds:0,color:colors[i]}));
  for(const a of activities.filter(a=>!a.planned)){
    const {ftp}=resolveFtp(a,settings);
    const frame=resampleActivity(effectiveStreams(a)),watts=frame.power,end=watts.length;
    for(const piece of frame.pieces){if(piece.power===null||!ftp)continue;const z=bounds.findIndex(b=>piece.power/ftp<=b);zones[z].seconds+=piece.end-piece.start;}
    const sums=new Float64Array(end+1),counts=new Uint32Array(end+1);
    for(let i=0;i<end;i++){const valid=Number.isFinite(watts[i]);sums[i+1]=sums[i]+(valid?watts[i]:0);counts[i+1]=counts[i]+(valid?1:0);}
    for(const seconds of durations){if(seconds>end)break;for(let i=seconds;i<=end;i++){if(counts[i]-counts[i-seconds]!==seconds)continue;const mean=(sums[i]-sums[i-seconds])/seconds;if(!best.has(seconds)||mean>best.get(seconds).watts)best.set(seconds,{seconds,watts:mean,activityId:a.id,start:frame.origin+i-seconds,end:frame.origin+i});}}
  }
  return {curve:[...best.values()].sort((a,b)=>a.seconds-b.seconds),zones,method:'时间加权 1 秒阶梯重采样；仅完整窗口；超过 30 秒缺口不补值，最后一点不外推；应用可逆功率修正。'};
}
