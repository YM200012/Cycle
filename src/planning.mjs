import {normalizeIntervals} from './workout.mjs';
import {randomUUID} from 'node:crypto';
const bad=message=>{const e=Error(message);e.status=400;throw e;};
const text=(v,label,max=250)=>{if(typeof v!=='string'||!v.trim()||v.length>max)bad(`${label} 无效`);return v.trim();};
const number=(v,label,min,max,integer=false)=>{if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max||(integer&&!Number.isInteger(v)))bad(`${label} 无效`);return v;};
export function planDate(v){if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v)||v<'1900-01-01'||v>'2200-12-31'||!Number.isFinite(Date.parse(v))||new Date(v).toISOString().slice(0,10)!==v)bad('计划日期无效');return v;}
export function normalizePlan(input,id=randomUUID()){
 if(!input||typeof input!=='object'||Array.isArray(input))bad('周期计划无效');
 const weeks=number(input.weeks,'计划周数',1,52,true),name=text(input.name,'计划名称');
 if(!Array.isArray(input.entries)||!input.entries.length||input.entries.length>500)bad('计划需要 1–500 项训练');
 if(input.description!==undefined&&(typeof input.description!=='string'||input.description.length>10000))bad('计划说明无效');
 const ids=new Set();const entries=input.entries.map(entry=>{
  if(!entry||typeof entry!=='object')bad('计划训练无效');const entryId=entry.id===undefined?randomUUID():text(entry.id,'训练 ID',100);if(ids.has(entryId))bad('计划训练 ID 重复');ids.add(entryId);
  const type=entry.type||'Ride';if(!['Ride','Run','Swim','Workout','Note'].includes(type))bad('计划运动类型无效');
  if(entry.notes!==undefined&&(typeof entry.notes!=='string'||entry.notes.length>10000))bad('训练备注无效');
  const intervals=normalizeIntervals(entry.intervals);
  return {id:entryId,day:number(entry.day,'计划日序',0,weeks*7-1,true),name:text(entry.name,'训练名称'),type,duration:number(entry.duration,'训练时长',0,2160),load:number(entry.load,'参考负荷',0,10000),intervals,notes:entry.notes||''};
 }).sort((a,b)=>a.day-b.day);
 return {id:text(id,'计划 ID',100),name,description:input.description||'',weeks,entries};
}
export function normalizePlanOrigin(origin){
 if(!origin||typeof origin!=='object'||Array.isArray(origin))bad('计划来源无效');
 return {planId:text(origin.planId,'计划 ID',100),planName:text(origin.planName,'计划名称'),batchId:text(origin.batchId,'批次 ID',100),entryId:text(origin.entryId,'计划训练 ID',100),startDate:planDate(origin.startDate),plannedDate:planDate(origin.plannedDate),targetDuration:number(origin.targetDuration,'目标时长',0,2160),targetLoad:number(origin.targetLoad,'目标负荷',0,10000)};
}
export function validatePlanningLinks(activities){
 const byId=new Map(activities.map(a=>[a.id,a])),used=new Set(),entries=new Set(),batches=new Map();
 for(const a of activities){
  if(a.planOrigin){const o=a.planOrigin,key=o.batchId+'|'+o.entryId;if(entries.has(key))bad('同批次计划训练重复');entries.add(key);const batch=batches.get(o.batchId);if(batch&&(batch.planId!==o.planId||batch.startDate!==o.startDate||batch.planName!==o.planName))bad('批次计划来源不一致');batches.set(o.batchId,o);}
  if(a.completionId===undefined)continue;
  const actual=byId.get(a.completionId);
  if(!a.planned||!a.planOrigin||!actual||actual.id===a.id||actual.planned||actual.type!==a.type||actual.planOrigin||used.has(actual.id))bad('实际活动关联无效：需为同类型、未关联的已完成活动');
  used.add(actual.id);
 }
}
export function planningOverview(activities,asOf=new Date().toISOString().slice(0,10)){
 planDate(asOf);
 const byId=new Map(activities.map(a=>[a.id,a])),map=new Map();
 for(const a of activities){
  if(!a.planOrigin)continue;
  const o=a.planOrigin;let b=map.get(o.batchId);
  if(!b){b={batchId:o.batchId,planId:o.planId,planName:o.planName,startDate:o.startDate,total:0,completed:0,plannedDuration:0,actualDuration:0,plannedLoad:0,actualLoad:0,dueTotal:0,dueCompleted:0,overdue:0,upcoming:0,dueToday:0,items:[]};map.set(o.batchId,b);}
  const actual=a.planned?(a.completionId?byId.get(a.completionId):null):a;
  const completed=Boolean(actual&&!actual.planned);
  const timing=completed?'completed':a.date<asOf?'overdue':a.date===asOf?'due-today':'upcoming';
  b.total++;b.completed+=completed?1:0;b.plannedDuration+=o.targetDuration;b.plannedLoad+=o.targetLoad;
  if(a.date<=asOf){b.dueTotal++;if(completed&&actual.date<=asOf)b.dueCompleted++;}
  if(timing==='overdue')b.overdue++;else if(timing==='due-today')b.dueToday++;else if(timing==='upcoming')b.upcoming++;
  if(completed){b.actualDuration+=actual.duration||0;b.actualLoad+=actual.load||0;}
  b.items.push({planned:a,actual:actual||null,status:completed?'completed':'pending',timing});
 }
 return {asOf,batches:[...map.values()].sort((a,b)=>b.startDate.localeCompare(a.startDate)).map(b=>({...b,adherenceRate:b.dueTotal?b.dueCompleted/b.dueTotal:null,items:b.items.sort((a,c)=>a.planned.date.localeCompare(c.planned.date))}))};
}
export function schedulePlan(plan,startDate){
 planDate(startDate);const batchId=randomUUID();
 const activities=plan.entries.map(entry=>{const date=new Date(Date.parse(startDate)+entry.day*86400000).toISOString().slice(0,10);planDate(date);return {name:entry.name,type:entry.type,date,duration:entry.duration,load:entry.load,intervals:entry.intervals,notes:entry.notes,planned:true,planOrigin:{planId:plan.id,planName:plan.name,batchId,entryId:entry.id,startDate,plannedDate:date,targetDuration:entry.duration,targetLoad:entry.load}};});
 return {batchId,activities};
}
