import {randomUUID} from 'node:crypto';
const bad=message=>{const e=Error(message);e.status=400;throw e;};
const types=new Set(['Ride','Run','Swim','Workout']);
const text=(value,label,max=10000,fallback='')=>{if(value===undefined)return fallback;if(typeof value!=='string'||value.length>max)bad(`${label}无效`);return value;};
const id=(value,label='ID')=>{const s=text(value,label,100).trim();if(!s)bad(`${label}不能为空`);return s;};
const number=(value,label,min,max,fallback=0)=>{if(value===undefined)return fallback;if(typeof value!=='number'||!Number.isFinite(value)||value<min||value>max)bad(`${label}需在 ${min}–${max} 范围内`);return value;};
export function workspaceDate(value){if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||value<'1900-01-01'||value>'2200-12-31'||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value)bad('日期必须为有效的 YYYY-MM-DD');return value;}
function activityType(value){const type=value??'Ride';if(!types.has(type))bad('运动类型无效');return type;}
export function normalizeGear(input,gearId=randomUUID()){
 if(!input||typeof input!=='object'||Array.isArray(input))bad('器材格式无效');
 const name=text(input.name,'器材名称',250).trim();if(!name)bad('请填写器材名称');if(input.active!==undefined&&typeof input.active!=='boolean')bad('启用状态需为布尔值');
 if(input.services!==undefined&&(!Array.isArray(input.services)||input.services.length>1000))bad('维护记录最多 1000 条');
 const services=(input.services||[]).map(row=>{if(!row||typeof row!=='object')bad('维护记录格式无效');return {date:workspaceDate(row.date),odometer:number(row.odometer,'维护里程',0,1e9),notes:text(row.notes,'维护说明')};});
 return {id:id(gearId),name,type:activityType(input.type),initialDistance:number(input.initialDistance,'初始里程',0,1e6),active:input.active??true,serviceEveryKm:input.serviceEveryKm===undefined||input.serviceEveryKm===null?null:number(input.serviceEveryKm,'维护间隔',1,1e6),servicedAtKm:number(input.servicedAtKm,'上次维护里程',0,1e9),notes:text(input.notes,'器材备注'),services};
}
export function gearUsage(gear,activities){
 const completed=activities.filter(a=>a.gearId===gear.id&&!a.planned),distance=gear.initialDistance+completed.reduce((sum,a)=>sum+(a.distance||0),0),sinceService=Math.max(0,distance-gear.servicedAtKm);
 return {distance,duration:completed.reduce((sum,a)=>sum+(a.duration||0),0),count:completed.length,sinceService,remainingKm:gear.serviceEveryKm===null?null:gear.serviceEveryKm-sinceService};
}
export function normalizeGoal(input,goalId=randomUUID()){
 if(!input||typeof input!=='object'||Array.isArray(input))bad('目标格式无效');const name=text(input.name,'目标名称',250).trim();if(!name)bad('请填写目标名称');const priority=input.priority??'B';if(!['A','B','C'].includes(priority))bad('目标优先级无效');
 const goal={id:id(goalId),name,date:workspaceDate(input.date),type:activityType(input.type),priority,targetDistance:input.targetDistance===undefined||input.targetDistance===null?null:number(input.targetDistance,'目标距离',0,10000),targetDuration:input.targetDuration===undefined||input.targetDuration===null?null:number(input.targetDuration,'目标时长',0,2160),notes:text(input.notes,'目标备注')};
 if(input.activityId!==undefined&&input.activityId!==null&&input.activityId!=='')goal.activityId=id(input.activityId,'目标实际活动 ID');return goal;
}
export function validateWorkspace(activities,gears,goals){
 const gearById=new Map(gears.map(g=>[g.id,g])),activityById=new Map(activities.map(a=>[a.id,a])),used=new Set();
 for(const a of activities)if(a.gearId){const gear=gearById.get(a.gearId);if(!gear||gear.type!==a.type)bad('活动器材需存在且运动类型一致');}
 for(const goal of goals)if(goal.activityId){const actual=activityById.get(goal.activityId);if(!actual||actual.planned||actual.type!==goal.type||used.has(actual.id))bad('目标关联需为同类型且未被其他目标占用的已完成活动');used.add(actual.id);}
}
export function validateGearAssignment(activity,gears,prior){
 if(!activity.gearId)return;const gear=gears.find(g=>g.id===activity.gearId);if(!gear||gear.type!==activity.type)bad('活动器材需存在且运动类型一致');if(!gear.active&&prior?.gearId!==activity.gearId)bad('停用器材不能分配给新活动');
}
export function goalOverview(goal,activities,asOf=new Date().toISOString().slice(0,10)){
 workspaceDate(asOf);const actual=goal.activityId?activities.find(a=>a.id===goal.activityId)||null:null,daysUntil=(Date.parse(goal.date)-Date.parse(asOf))/86400000;return {...goal,daysUntil,actual,status:actual?'recorded':daysUntil>0?'upcoming':daysUntil===0?'today':'past'};
}
