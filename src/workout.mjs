// Shared browser/server workout structure model. All durations are stored in minutes.
const fail=(message,line)=>{const error=Error(`${line?`第 ${line} 行：`:''}${message}`);error.status=400;throw error;};
const numeric=(value,label,min,max)=>{if(typeof value!=='number'||!Number.isFinite(value)||value<min||value>max)fail(`${label}需在 ${min}–${max} 范围内`);return value;};
export function normalizeIntervals(value=[]){
 if(!Array.isArray(value)||value.length>500)fail('训练步骤必须为最多 500 项的数组');
 return value.map((step,index)=>{
  if(!step||typeof step!=='object'||Array.isArray(step))fail(`步骤 ${index+1} 格式无效`);
  const result={duration:numeric(step.duration,'步骤时长 / 分钟',.01,2160),power:numeric(step.power,'FTP 百分比',0,500)};
  if(step.powerEnd!==undefined)result.powerEnd=numeric(step.powerEnd,'渐变结束 FTP 百分比',0,500);
  if(step.label!==undefined){if(typeof step.label!=='string'||step.label.length>120||/[\r\n]/.test(step.label))fail('步骤名称需为最多 120 字符的单行文本');result.label=step.label;}
  return result;
 });
}
export function workoutLoad(intervals){
 return normalizeIntervals(intervals).reduce((sum,step)=>{const a=step.power/100,b=(step.powerEnd??step.power)/100;return sum+step.duration/60*(a*a+a*b+b*b)/3*100;},0);
}
function durationMinutes(token,line){
 let seconds;
 const match=/^((?:\d+(?:\.\d+)?|\.\d+))\s*([ms])?$/i.exec(token);
 if(match)seconds=Number(match[1])*(match[2]?.toLowerCase()==='s'?1:60);
 else if(/^\d+(?::\d+){0,1}:\d+(?:\.\d+)?$/.test(token)){
  const parts=token.split(':').map(Number);if(parts.slice(1).some(p=>p>=60))fail('分:秒或时:分:秒中的分秒需小于 60',line);
  seconds=parts.reduce((total,part)=>total*60+part,0);
 }else fail('时长请填写分钟、10m、90s、分:秒或时:分:秒',line);
 if(!Number.isFinite(seconds)||seconds<.6||seconds>2160*60)fail('每步时长需为 0.6 秒至 2160 分钟',line);
 return seconds/60;
}
export function parseWorkout(text){
 if(typeof text!=='string'||text.length>30000)fail('训练文本必须为最多 30000 字符的文本');
 const lines=text.replace(/\r\n?/g,'\n').split('\n').map((text,index)=>({text:text.trim(),line:index+1})).filter(row=>row.text&&!row.text.startsWith('#'));
 let position=0;
 function block(depth,opening){
  const result=[];
  while(position<lines.length){
   const row=lines[position++];
   if(row.text==='}'){if(!opening)fail('多余的结束花括号',row.line);if(!result.length)fail('重复组不能为空',row.line);return result;}
   const repeat=/^(\d+)\s*[x×]\s*\{$/i.exec(row.text);
   if(repeat){
    if(depth>=4)fail('重复组最多嵌套 4 层',row.line);
    const count=Number(repeat[1]);if(count<1||count>50)fail('重复次数需为 1–50',row.line);
    const children=block(depth+1,row.line);if(result.length+children.length*count>500)fail('展开后最多 500 个步骤',row.line);
    for(let i=0;i<count;i++)for(const step of children)result.push({...step});
    continue;
   }
   const step=/^(.+?)\s*@\s*((?:\d+(?:\.\d+)?|\.\d+))\s*%?(?:\s*-\s*((?:\d+(?:\.\d+)?|\.\d+))\s*%?)?(?:\s*\|\s*(.*))?$/.exec(row.text);
   if(!step)fail('步骤格式无效，请填写 10m @ 60 或 4x { … }',row.line);
   const duration=durationMinutes(step[1].trim(),row.line),power=Number(step[2]);
   if(power>500||(step[3]!==undefined&&Number(step[3])>500))fail('FTP 百分比需为 0–500',row.line);
   const value={duration,power};if(step[3]!==undefined)value.powerEnd=Number(step[3]);
   if(step[4]!==undefined){if(step[4].length>120)fail('步骤名称最多 120 字符',row.line);value.label=step[4].trim();}
   result.push(value);if(result.length>500)fail('展开后最多 500 个步骤',row.line);
  }
  if(opening)fail('重复组缺少结束花括号',opening);
  return result;
 }
 const intervals=block(0);if(!intervals.length)fail('至少填写一个训练步骤',1);
 const duration=intervals.reduce((sum,step)=>sum+step.duration,0);
 if(duration>2160+1e-9)fail('总训练时长不能超过 2160 分钟',lines.at(-1)?.line||1);
 const load=Math.round(workoutLoad(intervals));if(load>10000)fail('参考负荷不能超过 10000，请缩短训练',lines.at(-1)?.line||1);
 return {intervals,duration,load};
}
const displayNumber=value=>Number(value.toPrecision(14)).toString();
export function formatWorkout(intervals){
 return normalizeIntervals(intervals).map(step=>`${displayNumber(step.duration*60)}s @ ${displayNumber(step.power)}${step.powerEnd===undefined?'':`-${displayNumber(step.powerEnd)}`}%${step.label?` | ${step.label}`:''}`).join('\n');
}
const xml=value=>String(value??'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'�').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
export function workoutZwo(workout){
 if(!workout||!['Ride','Workout'].includes(workout.type||'Ride'))fail('ZWO 功率训练导出仅支持骑行或通用训练');
 const intervals=normalizeIntervals(workout.intervals);if(!intervals.length)fail('没有可导出的训练步骤');
 const steps=intervals.map(step=>{
  const duration=displayNumber(step.duration*60),a=displayNumber(step.power/100),b=displayNumber((step.powerEnd??step.power)/100);
  const tag=step.powerEnd!==undefined&&step.powerEnd!==step.power?(step.powerEnd>step.power?'Warmup':'Cooldown'):'SteadyState';
  const target=tag==='SteadyState'?`Power="${a}"`:`PowerLow="${a}" PowerHigh="${b}"`;
  return `    <${tag} Duration="${duration}" ${target}>${step.label?`<textevent timeoffset="0" message="${xml(step.label)}"/>`:''}</${tag}>`;
 }).join('\n');
 return `<?xml version="1.0" encoding="UTF-8"?>\n<workout_file>\n  <author>Cycle Local</author>\n  <name>${xml(workout.name||'本地训练')}</name>\n  <description>${xml(workout.description||'')}</description>\n  <sportType>bike</sportType>\n  <workout>\n${steps}\n  </workout>\n</workout_file>\n`;
}
