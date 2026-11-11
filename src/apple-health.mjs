import {createHash} from 'node:crypto';
import {healthTypeLabel,healthTypeRule,normalizeHealthQuantity,healthStateLabel,categoryState} from './health-catalog.mjs';
/** Apple Health Record summaries only: no network, DTD resolution, or workout import. */
const DAY=86400000,MAX_BYTES=2*1024*1024*1024,MAX_TOKEN=1024*1024,MAX_SAMPLES=5000000,MAX_DAYS=3661;
const TYPES={HKQuantityTypeIdentifierBodyMass:'weight',HKQuantityTypeIdentifierRestingHeartRate:'restHr',HKQuantityTypeIdentifierHeartRateVariabilitySDNN:'hrv',HKCategoryTypeIdentifierSleepAnalysis:'sleep'};
export const APPLE_HEALTH_TYPES=Object.freeze([
 {id:'HKQuantityTypeIdentifierBodyMass',key:'weight',label:'体重',supported:true},
 {id:'HKQuantityTypeIdentifierRestingHeartRate',key:'restHr',label:'静息心率',supported:true},
 {id:'HKQuantityTypeIdentifierHeartRateVariabilitySDNN',key:'hrv',label:'HRV（SDNN）',supported:true},
 {id:'HKCategoryTypeIdentifierSleepAnalysis',key:'sleep',label:'睡眠',supported:true}
].map(type=>Object.freeze(type)));
function selectedTypes(types){
 if(types===undefined)return new Set(Object.values(TYPES));
 if(!Array.isArray(types)||!types.length||types.length>2000)fail('请选择至少一种健康类型');
 const selected=new Set();for(const type of types){if(typeof type!=='string'||!type.length||type.length>250||!/[A-Za-z]/.test(type[0]))fail('健康类型标识无效');selected.add(Object.hasOwn(TYPES,type)?TYPES[type]:type);}return selected;
}
const ASLEEP=new Set(['HKCategoryValueSleepAnalysisAsleep','HKCategoryValueSleepAnalysisAsleepUnspecified','HKCategoryValueSleepAnalysisAsleepCore','HKCategoryValueSleepAnalysisAsleepDeep','HKCategoryValueSleepAnalysisAsleepREM','1','3','4','5']);
const fail=message=>{throw Object.assign(Error(message),{status:400});};
const dateKey=ms=>new Date(ms).toISOString().slice(0,10);
function validDay(value,label){if(typeof value!=='string'||!/^\d{4}-\d\d-\d\d$/.test(value)||value<'1900-01-01'||value>'2200-12-31'||!Number.isFinite(Date.parse(value))||dateKey(Date.parse(value))!==value)fail(`${label}日期必须为有效的 YYYY-MM-DD`);return value;}
function timestamp(value){
 const m=typeof value==='string'&&/^(\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d):(\d\d)(?:\.(\d{1,3}))?\s*(Z|[+-]\d\d:?\d\d)$/.exec(value);
 if(!m)fail('Apple 健康记录必须含完整时间和明确时区');
 const [year,month,day,hour,minute,second]=m.slice(1,7).map(Number),millisecond=Number((m[7]||'').padEnd(3,'0')),local=Date.UTC(year,month-1,day,hour,minute,second,millisecond),d=new Date(local);
 if(year<1900||year>2200||d.getUTCFullYear()!==year||d.getUTCMonth()!==month-1||d.getUTCDate()!==day||hour>23||minute>59||second>59)fail('Apple 健康记录时间无效');
 let offset=0;if(m[8]!=='Z'){const z=/^([+-])(\d\d):?(\d\d)$/.exec(m[8]),h=Number(z[2]),min=Number(z[3]);if(h>14||min>59||h===14&&min!==0)fail('Apple 健康记录时区无效');offset=(z[1]==='-'?-1:1)*(h*60+min);}
 return {epoch:local-offset*60000,offset,date:dateKey(local)};
}
function entities(text){
 if(text.includes('<')||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text))fail('XML 属性中包含未转义或非法字符');
 let out='',at=0;while(at<text.length){const start=text.indexOf('&',at);if(start<0){out+=text.slice(at);break;}out+=text.slice(at,start);const stop=text.indexOf(';',start+1);if(stop<0)fail('XML 实体格式无效');const key=text.slice(start+1,stop),named={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"};
  if(Object.hasOwn(named,key))out+=named[key];else{let n;if(/^#x[\da-f]+$/i.test(key))n=parseInt(key.slice(2),16);else if(/^#\d+$/.test(key))n=Number(key.slice(1));else fail('不支持自定义 XML 实体');
   if(!Number.isInteger(n)||n>0x10ffff||n>=0xd800&&n<=0xdfff||n<32&&![9,10,13].includes(n)||n===0xfffe||n===0xffff)fail('XML 字符实体无效');out+=String.fromCodePoint(n);
  }at=stop+1;
 }return out;
}
function attributes(text){
 const out=Object.create(null);let i=0,count=0;
 while(i<text.length){if(!/\s/.test(text[i]))fail('XML 属性之间缺少空格');while(i<text.length&&/\s/.test(text[i]))i++;if(i===text.length)break;
  const m=/^([A-Za-z_:][\w:.-]*)\s*=\s*(["'])/.exec(text.slice(i));if(!m)fail('XML 属性格式无效');const name=m[1];if(Object.hasOwn(out,name)||++count>100)fail('XML 属性重复或过多');i+=m[0].length;const end=text.indexOf(m[2],i);if(end<0)fail('XML 属性引号未闭合');out[name]=entities(text.slice(i,end));i=end+1;
 }return out;
}
function tokenEnd(text){
 if(text.startsWith('<!--')){const i=text.indexOf('-->');return i<0?-1:i+3;}
 if(text.startsWith('<![CDATA[')){const i=text.indexOf(']]>');return i<0?-1:i+3;}
 let quote='',brackets=0;const dtd=/^<!DOCTYPE\b/i.test(text);
 for(let i=1;i<text.length;i++){const c=text[i];if(quote){if(c===quote)quote='';continue;}if(c==='"'||c==="'"){quote=c;continue;}if(dtd){if(c==='[')brackets++;else if(c===']')brackets--;if(brackets<0)fail('XML DTD 格式无效');}if(c==='>'&&!brackets)return i+1;}return -1;
}
async function walkAppleHealthXml(iterable,{onRecord,onWorkout}={}){
 const stack=[];let pending='',bytes=0,opened=false,closed=false,doctype=false;const decoder=new TextDecoder('utf-8',{fatal:true});
 function consume(token){
  if(/^<!ENTITY\b/i.test(token)||/<!ENTITY\b/i.test(token))fail('不允许 XML 实体声明');
  if(token.startsWith('<!--')){if(token.slice(4,-3).includes('--'))fail('XML 注释格式无效');return;}
  if(token.startsWith('<?')){if(!token.endsWith('?>'))fail('XML 声明格式无效');return;}
  if(/^<!DOCTYPE\b/i.test(token)){if(opened||doctype||!/^<!DOCTYPE\s+HealthData(?:\s|\[|>)/.test(token)||/\b(?:SYSTEM|PUBLIC)\s+["']/i.test(token))fail('不支持此 XML DTD');doctype=true;return;}
  if(token.startsWith('<![CDATA[')){if(!opened||closed)fail('XML 根节点外包含内容');return;}
  if(token.startsWith('<!'))fail('不支持的 XML 声明');
  if(token.startsWith('</')){const m=/^<\/([A-Za-z_:][\w:.-]*)\s*>$/.exec(token);if(!m||stack.pop()!==m[1])fail('XML 节点未正确闭合');if(m[1]==='HealthData')closed=true;return;}
  const m=/^<([A-Za-z_:][\w:.-]*)([\s\S]*?)(\/?)>$/.exec(token);if(!m)fail('XML 标签格式无效');const name=m[1],attrs=attributes(m[2]),self=Boolean(m[3]);
  if(!stack.length){if(opened||closed||name!=='HealthData')fail('文件必须有且仅有一个 HealthData 根节点');opened=true;}else if(name==='HealthData')fail('HealthData 根节点不能嵌套');
  if(name==='Workout')onWorkout?.();
  if(name==='Record'){const inWorkout=stack.includes('Workout');if(!inWorkout&&stack.at(-1)!=='HealthData')fail('Record 必须位于 HealthData 内');onRecord?.(attrs,{inWorkout});}
  if(!self){stack.push(name);if(stack.length>64)fail('XML 嵌套层级过深');}else if(name==='HealthData')closed=true;
 }
 function scan(){
  let used=0;while(used<pending.length){const start=pending.indexOf('<',used);if(start<0){if(pending.slice(used).trim())fail('XML 标签外包含非法内容');used=pending.length;break;}if(pending.slice(used,start).trim())fail('XML 标签外包含非法内容');const tail=pending.slice(start),end=tokenEnd(tail);if(end<0){if(tail.length>MAX_TOKEN)fail('XML 单个标签或 DTD 过大');used=start;break;}if(end>MAX_TOKEN)fail('XML 单个标签或 DTD 过大');consume(tail.slice(0,end));used=start+end;}
  pending=pending.slice(used);
 }
 try{for await(const chunk of iterable){let text;if(typeof chunk==='string'){bytes+=new TextEncoder().encode(chunk).length;text=chunk;}else{const b=chunk instanceof Uint8Array?chunk:new Uint8Array(chunk);bytes+=b.byteLength;text=decoder.decode(b,{stream:true});}if(bytes>MAX_BYTES)fail('健康 XML 超过 2 GB，请缩小导出范围');pending+=text;scan();}pending+=decoder.decode();scan();}catch(error){if(error?.status)throw error;if(error instanceof TypeError)fail('健康 XML 必须为有效 UTF-8');throw error;}
 if(pending.trim()||!opened||!closed||stack.length)fail('健康 XML 不完整或节点未闭合');
}

/**
 * Parse chunked XML, then return daily summaries only. Sleep days run local noon
 * to next noon and use that next calendar date, keeping an overnight night intact.
 * The explicit end-date UTC offset defines the noon boundary (no host timezone use).
 */
export async function parseAppleHealthStream(iterable,{from,to,types,maxSamples=MAX_SAMPLES}={}){
 const selected=selectedTypes(types);
 if(from!==undefined)validDay(from,'开始');if(to!==undefined)validDay(to,'结束');if(from&&to&&(from>to||(Date.parse(to)-Date.parse(from))/DAY>3660))fail('健康导入日期范围需为 0–3660 天');
 if(!Number.isInteger(maxSamples)||maxSamples<1||maxSamples>5000000)fail('健康导入采样上限无效');
 const included=date=>(!from||date>=from)&&(!to||date<=to),days=new Map(),seen=new Map(),sourceNames=new Set();
 const summary={totalRecords:0,matchedRecords:0,acceptedRecords:0,duplicateRecords:0,ignoredRecords:0,workoutsIgnored:0,days:0,from:from||null,to:to||null,byType:{weight:0,restHr:0,hrv:0,sleep:0},selectedTypes:[...selected].map(key=>Object.keys(TYPES).find(id=>TYPES[id]===key)||key),sleepDayRule:'local-noon-to-noon; assigned to ending calendar day; explicit sample end UTC offset'};
 function daily(date){let out=days.get(date);if(!out){if(days.size>=MAX_DAYS)fail('健康导入天数过多，请缩小日期范围');out={date,fields:{}};days.set(date,out);}return out;}
 function addSource(field,source){field.names.add(source);sourceNames.add(source);if(sourceNames.size>1000)fail('健康数据来源过多，请缩小日期范围');}
 function fieldFor(date,key){const day=daily(date);return day.fields[key]??(day.fields[key]={names:new Set(),values:[],sum:0,count:0,intervals:[],latest:null,sampleCount:0,start:null,end:null});}
 function cover(field,start,end){field.sampleCount++;field.start=field.start===null?start:Math.min(field.start,start);field.end=field.end===null?end:Math.max(field.end,end);}
 function appendInterval(intervals,start,end){const last=intervals.at(-1);if(last&&start>=last[0]&&start<=last[1])last[1]=Math.max(last[1],end);else intervals.push([start,end]);}
 function unionDuration(intervals){const sorted=intervals.sort((a,b)=>a[0]-b[0]);let total=0,begin=null,end=null;for(const [a,b]of sorted){if(begin===null){begin=a;end=b;}else if(a<=end)end=Math.max(end,b);else{total+=end-begin;begin=a;end=b;}}return begin===null?0:total+end-begin;}
 function genericField(date,meta){const day=daily(date);day.generic??=new Map();let field=day.generic.get(meta.id);if(!field){if(day.generic.size>=4000)fail('每日健康指标通道过多');field={...meta,names:new Set(),sum:0,count:0,min:Infinity,max:-Infinity,sampleCount:0,start:null,end:null,intervals:[],latest:null,perSource:new Map()};day.generic.set(meta.id,field);}return field;}
 function addGeneric(field,source,start,end,value){cover(field,start,end);addSource(field,source);field.count++;if(field.method==='union')appendInterval(field.intervals,start,end);else if(field.method==='count')field.sum++;
  else{field.sum+=value;field.min=Math.min(field.min,value);field.max=Math.max(field.max,value);if(!field.latest||end>field.latest.end||end===field.latest.end&&value>field.latest.value)field.latest={end,value};
   if(field.method==='sum'){let owned=field.perSource.get(source);if(!owned){owned={name:source,sum:0,count:0,start:null,end:null,intervals:[],min:Infinity,max:-Infinity};field.perSource.set(source,owned);}owned.sum+=value;owned.count++;owned.start=owned.start===null?start:Math.min(owned.start,start);owned.end=owned.end===null?end:Math.max(owned.end,end);appendInterval(owned.intervals,start,end);owned.min=Math.min(owned.min,value);owned.max=Math.max(owned.max,value);}
  }
 }
 function finishGeneric(field){let value=field.sum,owned=null;if(field.method==='mean')value=field.sum/field.count;else if(field.method==='last')value=field.latest.value;else if(field.method==='union')value=unionDuration(field.intervals)/3600000;else if(field.method==='sum'){
  const sources=[...field.perSource.values()].map(s=>({...s,covered:unionDuration(s.intervals)})).sort((a,b)=>b.covered-a.covered||b.count-a.count||a.name.localeCompare(b.name));owned=sources[0];value=owned.sum;
 }
 if(!Number.isFinite(value))fail('健康日汇总无效');const out={id:field.id,type:field.type,label:field.label,unit:field.unit,kind:field.kind,method:field.method,value:Math.round(value*1e6)/1e6,sampleCount:owned?.count||field.sampleCount,start:owned?.start??field.start,end:owned?.end??field.end,names:[...field.names].sort()};if(field.state!==undefined)out.state=field.state;
 if(field.kind==='quantity'){out.min=owned?.min??field.min;out.max=owned?.max??field.max;}if(owned){out.selectedSource=owned.name;out.sourcePolicy='most-covered-source';}return out;
 }
 function genericRecord(attrs,{sleep=false,track=true}={}){
  const type=attrs.type;if(typeof type!=='string'||!type.length||type.length>250)fail('健康记录缺少有效类型标识');if(!sleep&&!selected.has(type)){if(track)summary.ignoredRecords++;return false;}if(track)summary.matchedRecords++;
  const start=timestamp(attrs.startDate),end=timestamp(attrs.endDate);if(end.epoch<start.epoch)fail('Apple 健康记录结束时间早于开始时间');
  const source=(attrs.sourceName||'Apple Health').trim()||'Apple Health';if(source.length>250)fail('健康数据来源名称过长');const rule=healthTypeRule(type),number=typeof attrs.value==='string'&&/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?$/i.test(attrs.value);
  if(type.startsWith('HKQuantityTypeIdentifier')&&!number)fail('健康数量记录必须包含有限数值');
  const category=sleep||rule.kind==='category'||!number;let meta,parts=[],value;
  if(category){if(typeof attrs.value!=='string'||attrs.value.length>500)fail('健康分类记录值缺失或过长');const state=categoryState(type,attrs.value),duration=end.epoch>start.epoch,unit=duration?'h':'次';meta={id:type+'::'+encodeURIComponent(state)+'::'+(duration?'hours':'count'),type,label:healthTypeLabel(type)+' · '+healthStateLabel(type,state),unit,kind:'category',method:duration?'union':'count',state};
   if(duration){if(end.epoch-start.epoch>3660*DAY)fail('健康分类记录时间跨度过长');let at=start.epoch;while(at<end.epoch){const shifted=at+end.offset*60000+(sleep?-12*3600000+DAY:0),date=dateKey(shifted),boundary=Date.parse(date+(sleep?'T12:00:00Z':'T00:00:00Z'))-end.offset*60000+(sleep?0:DAY),stop=Math.min(end.epoch,boundary);if(stop<=at)fail('健康分类日期边界无效');if(included(date))parts.push({date,start:at,end:stop});at=stop;}}
   else if(included(end.date))parts=[{date:end.date,start:start.epoch,end:end.epoch}];
  }else{if(!included(end.date)){if(track)summary.ignoredRecords++;return false;}value=Number(attrs.value);if(!Number.isFinite(value))fail('健康记录数值必须为有限数');const normalized=normalizeHealthQuantity(type,attrs.unit||'',value);value=normalized.value;if(!Number.isFinite(value)||Math.abs(value)>1e15)fail('健康记录数值超出可绘制范围');meta={id:type+'::'+encodeURIComponent(normalized.unit),type,label:rule.label,unit:normalized.unit,kind:'quantity',method:rule.method};parts=[{date:end.date,start:start.epoch,end:end.epoch}];}
  if(!parts.length){if(track)summary.ignoredRecords++;return false;}
  // Source identity is included only for cumulative quantities: each provider's
  // daily total is computed independently and the best-covered provider wins.
  const signature=createHash('sha256').update('generic|'+meta.id+'|'+start.epoch+'|'+end.epoch+'|'+(category?'category':value.toPrecision(12))+(meta.method==='sum'?'|'+source:'')).digest('base64').slice(0,22);
  if(seen.has(signature)){if(track)summary.duplicateRecords++;for(const field of (Array.isArray(seen.get(signature))?seen.get(signature):[seen.get(signature)]))addSource(field,source);return false;}
  if(seen.size>=maxSamples)fail('有效健康采样过多，请缩小日期范围');const fields=parts.map(p=>genericField(p.date,meta));seen.set(signature,fields.length===1?fields[0]:fields);for(let i=0;i<parts.length;i++)addGeneric(fields[i],source,parts[i].start,parts[i].end,value);if(track){summary.acceptedRecords++;summary.byType[type]=(Object.hasOwn(summary.byType,type)?summary.byType[type]:0)+1;}return true;
 }

 function record(attrs){
  summary.totalRecords++;const key=Object.hasOwn(TYPES,attrs.type)?TYPES[attrs.type]:null;if(!key){genericRecord(attrs);return;}if(!selected.has(key)){summary.ignoredRecords++;return;}summary.matchedRecords++;
  const start=timestamp(attrs.startDate),end=timestamp(attrs.endDate);if(end.epoch<start.epoch)fail('Apple 健康记录结束时间早于开始时间');
  const source=(attrs.sourceName||'Apple Health').trim()||'Apple Health';if(source.length>250)fail('健康数据来源名称过长');
  if(key!=='sleep'&&!included(end.date)){summary.ignoredRecords++;return;}
  let value;if(key==='sleep'){
   const stageAdded=types!==undefined&&genericRecord(attrs,{sleep:true,track:false});
   if(!ASLEEP.has(attrs.value)){if(stageAdded)summary.acceptedRecords++;else summary.ignoredRecords++;return;}if(end.epoch<=start.epoch||end.epoch-start.epoch>36*3600000)fail('睡眠记录时长无效');
   // Filter before keeping intervals; split only at explicit-offset noon boundaries.
   let at=start.epoch;const intervals=[];while(at<end.epoch){const date=dateKey(at+end.offset*60000-12*3600000+DAY),boundary=Date.parse(date+'T12:00:00Z')-end.offset*60000,stop=Math.min(end.epoch,boundary);if(stop<=at)fail('睡眠记录日期边界无效');if(included(date))intervals.push({date,start:at,end:stop});at=stop;}
   if(!intervals.length){summary.ignoredRecords++;return;}value=intervals;
  }else{
   if(typeof attrs.value!=='string'||!/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?$/i.test(attrs.value))fail('健康记录数值无效');value=Number(attrs.value);if(!Number.isFinite(value))fail('健康记录数值必须为有限数');
   if(key==='weight'){if(attrs.unit==='lb')value*=.45359237;else if(attrs.unit!=='kg')fail('体重仅支持 kg 或 lb');if(value<20||value>300)fail('体重必须在 20–300 kg 范围内');}
   if(key==='restHr'){if(!['count/min','bpm'].includes(attrs.unit))fail('静息心率单位必须为 count/min');if(value<20||value>250)fail('静息心率必须在 20–250 bpm 范围内');}
   if(key==='hrv'){if(attrs.unit==='s')value*=1000;else if(attrs.unit!=='ms')fail('HRV 单位必须为 ms 或 s');if(value<0||value>500)fail('HRV SDNN 必须在 0–500 ms 范围内');}
  }
  const signature=createHash('sha256').update(key+'|'+start.epoch+'|'+end.epoch+'|'+(key==='sleep'?'asleep':Math.round(value*1e6)/1e6)).digest('base64').slice(0,22),duplicate=seen.has(signature);
  if(duplicate){summary.duplicateRecords++;for(const date of seen.get(signature))addSource(fieldFor(date,key),source);return;}
  if(seen.size>=maxSamples)fail('有效健康采样过多，请缩小日期范围');seen.set(signature,key==='sleep'?[...new Set(value.map(i=>i.date))]:[end.date]);summary.acceptedRecords++;summary.byType[key]++;
  if(key==='sleep'){for(const interval of value){const field=fieldFor(interval.date,key);field.intervals.push([interval.start,interval.end]);cover(field,interval.start,interval.end);addSource(field,source);}return;}
  const field=fieldFor(end.date,key);cover(field,start.epoch,end.epoch);addSource(field,source);if(key==='weight'){const tie=end.epoch+'|'+start.epoch+'|'+source+'|'+value;if(!field.latest||end.epoch>field.latest.time||end.epoch===field.latest.time&&tie>field.latest.tie)field.latest={time:end.epoch,tie,value};}
  else if(key==='restHr'){field.sum+=value;field.count++;}else field.values.push(value);
 }
 await walkAppleHealthXml(iterable,{onRecord:(attrs,{inWorkout})=>{if(inWorkout){summary.totalRecords++;summary.ignoredRecords++;}else record(attrs);},onWorkout:()=>summary.workoutsIgnored++});
 const records=[...days.values()].sort((a,b)=>a.date.localeCompare(b.date)).map(day=>{const out={date:day.date,sources:{}};if(day.generic?.size)out.healthMetrics=[...day.generic.values()].map(finishGeneric).sort((a,b)=>a.id.localeCompare(b.id));for(const [key,field]of Object.entries(day.fields)){let value,method;if(key==='weight'){value=field.latest?.value;method='last';}else if(key==='restHr'){value=field.sum/field.count;method='mean';}else if(key==='hrv'){const values=field.values.sort((a,b)=>a-b),n=values.length;value=n%2?values[(n-1)/2]:(values[n/2-1]+values[n/2])/2;method='median';}else{const intervals=field.intervals.sort((a,b)=>a[0]-b[0]);let total=0,begin=null,end=null;for(const [a,b]of intervals){if(begin===null){begin=a;end=b;}else if(a<=end)end=Math.max(end,b);else{total+=end-begin;begin=a;end=b;}}if(begin!==null)total+=end-begin;value=total/3600000;if(value>24+1e-9)fail('汇总睡眠超过 24 小时');method='union';}if(!Number.isFinite(value))fail('健康日汇总无效');out[key]=Math.round(value*1000)/1000;out.sources[key]={provider:'Apple Health',kind:key==='hrv'?'heartRateVariabilitySDNN':key==='restHr'?'restingHeartRate':key==='weight'?'bodyMass':'sleepAnalysis',names:[...field.names].sort(),method,sampleCount:field.sampleCount,start:field.start,end:field.end};}return out;});
 summary.days=records.length;return {records,summary,sources:[...sourceNames].sort()};
}
export async function parseAppleHealthXml(text,options){if(typeof text!=='string')fail('健康 XML 必须为文本');return parseAppleHealthStream([text.replace(/^\uFEFF/,'')],options);}

/** Discovery reads structure and counts only. It never imports values or retains
 * unselected raw health samples; callers can re-read their local staged file. */
export async function inspectAppleHealthStream(iterable){
 const groups=new Map();let totalRecords=0,healthRecords=0,workoutsIgnored=0;
 await walkAppleHealthXml(iterable,{onWorkout:()=>workoutsIgnored++,onRecord:(attrs,{inWorkout})=>{
  totalRecords++;if(inWorkout)return;healthRecords++;
  const id=attrs.type;if(typeof id!=='string'||!id.length||id.length>250)fail('健康记录缺少有效类型标识');
  let type=groups.get(id);if(!type){if(groups.size>=2000)fail('健康数据类型过多');const known=APPLE_HEALTH_TYPES.find(type=>type.id===id);type={id,key:known?.key||id,label:known?.label||healthTypeLabel(id),supported:true,count:0,from:null,to:null,invalidDates:0,units:new Set()};groups.set(id,type);}type.count++;
  if(attrs.unit){if(attrs.unit.length>100||type.units.size>=50&&!type.units.has(attrs.unit))fail('健康记录单位过多或过长');type.units.add(attrs.unit);}
  try{const start=timestamp(attrs.startDate),end=timestamp(attrs.endDate);if(end.epoch<start.epoch)throw Error('negative duration');let from=end.date,to=end.date;
   if(type.key==='sleep'&&ASLEEP.has(attrs.value)&&end.epoch>start.epoch){from=dateKey(start.epoch+end.offset*60000-12*3600000+DAY);to=dateKey(end.epoch-1+end.offset*60000-12*3600000+DAY);}
   if(!type.from||from<type.from)type.from=from;if(!type.to||to>type.to)type.to=to;
  }catch{type.invalidDates++;}
 }});
 const types=[...groups.values()].map(type=>({...type,units:[...type.units].sort()})).sort((a,b)=>Number(b.supported)-Number(a.supported)||a.label.localeCompare(b.label,'zh-CN')||a.id.localeCompare(b.id));
 const from=types.map(type=>type.from).filter(Boolean).sort()[0]||null,to=types.map(type=>type.to).filter(Boolean).sort().at(-1)||null;
 return {types,typeCount:types.length,supportedTypeCount:types.filter(type=>type.supported).length,totalRecords,healthRecords,workoutsIgnored,from,to};
}
export async function inspectAppleHealthXml(text){if(typeof text!=='string')fail('健康 XML 必须为文本');return inspectAppleHealthStream([text.replace(/^\uFEFF/,'')]);}
