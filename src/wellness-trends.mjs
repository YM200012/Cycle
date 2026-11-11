// Daily wellness observations and descriptive trends. Missing measurements remain null.
export const wellnessMetrics = {
  weight: {label:'体重',unit:'kg',min:20,max:300},
  restHr: {label:'静息心率',unit:'bpm',min:20,max:250},
  hrv: {label:'HRV',unit:'ms',min:0,max:500},
  sleep: {label:'睡眠',unit:'h',min:0,max:24},
  fatigue: {label:'疲劳感',unit:'/ 5',min:1,max:5}
};
const DAY=86400000;
function date(value){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||value<'1900-01-01'||value>'2200-12-31'||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value)throw Error('趋势日期必须为有效的 YYYY-MM-DD（1900–2200 年）');
  return value;
}
function validDate(value){try{return date(value);}catch{return null;}}
function observed(record,key){const value=record?.[key],meta=wellnessMetrics[key];return typeof value==='number'&&Number.isFinite(value)&&value>=meta.min&&value<=meta.max?value:null;}
export function wellnessTrends(records=[],activities=[],{from,to}={}){
  date(from);date(to);const start=Date.parse(from),stop=Date.parse(to),length=(stop-start)/DAY+1;
  if(length<1||length>366)throw Error('健康趋势日期范围需为 1–366 天');
  if(!Array.isArray(records)||!Array.isArray(activities))throw Error('健康记录与活动必须为数组');
  const byDate=new Map();
  for(const record of records){const key=validDate(record?.date);if(key)byDate.set(key,record);}
  const loads=new Map(),trainingDays=new Set();
  for(const activity of activities){const key=validDate(activity?.date);if(!key||key<from||key>to||activity.planned)continue;trainingDays.add(key);const value=activity.load;if(typeof value==='number'&&Number.isFinite(value)&&value>=0)loads.set(key,(loads.get(key)||0)+value);}
  const daily=[];
  for(let time=start;time<=stop;time+=DAY){
    const key=new Date(time).toISOString().slice(0,10),row={date:key,load:loads.get(key)||0,mean7:{},counts7:{}};
    for(const metric of Object.keys(wellnessMetrics)){
      row[metric]=observed(byDate.get(key),metric);const values=[];
      for(let back=0;back<7;back++){const d=new Date(time-back*DAY).toISOString().slice(0,10),v=observed(byDate.get(d),metric);if(v!==null)values.push(v);}
      row.counts7[metric]=values.length;row.mean7[metric]=values.length>=3?values.reduce((s,v)=>s+v,0)/values.length:null;
    }
    daily.push(row);
  }
  const summary={};
  for(const metric of Object.keys(wellnessMetrics)){
    const measured=daily.filter(row=>row[metric]!==null),latest=measured.at(-1);
    summary[metric]={latest:latest?.[metric]??null,valueDate:latest?.date??null,mean:measured.length?measured.reduce((s,row)=>s+row[metric],0)/measured.length:null,count:measured.length};
  }
  return {daily,summary,training:{days:trainingDays.size,totalLoad:daily.reduce((sum,row)=>sum+row.load,0)},range:{from,to,days:length}};
}
