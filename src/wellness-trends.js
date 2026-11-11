import {wellnessTrends,wellnessMetrics} from './wellness-trends.mjs';
const methodLabels={sum:'每日总量',mean:'每日均值',last:'每日最后值',union:'每日合并时长',count:'每日事件次数',median:'每日中位数'};
const DAY=86400000;
const rangeDates=(from,to)=>Array.from({length:Math.floor((Date.parse(to)-Date.parse(from))/DAY)+1},(_,i)=>new Date(Date.parse(from)+i*DAY).toISOString().slice(0,10));
export function healthChartGroups({records=[],from,to,esc,chart,num,prefix='health',includeLegacy=false}){
 const dates=rangeDates(from,to),byDate=new Map(records.map(row=>[row.date,row])),channels=new Map();
 for(const row of records)for(const metric of row.healthMetrics||[])if(Number.isFinite(metric.value)&&!channels.has(metric.id))channels.set(metric.id,metric);
 if(includeLegacy)for(const [key,meta]of Object.entries(wellnessMetrics))if(records.some(row=>Number.isFinite(row[key])))channels.set('legacy:'+key,{id:'legacy:'+key,type:'legacy:'+key,label:key==='hrv'?'HRV（SDNN）':meta.label,unit:meta.unit,kind:'quantity',method:key==='weight'?'last':key==='hrv'?'median':key==='sleep'?'union':'mean',legacy:key});
 const groups=new Map(),observations=new Map();
 for(const row of records)for(const metric of row.healthMetrics||[])observations.set(row.date+'\n'+metric.id,metric.value);
 for(const metric of channels.values()){
  const entries=dates.map(date=>{const row=byDate.get(date);const value=metric.legacy?row?.[metric.legacy]:observations.get(date+'\n'+metric.id);return Number.isFinite(value)?value:null;}),measured=entries.filter(Number.isFinite),count=measured.length;
  if(!count)continue;
  const latestIndex=entries.findLastIndex(Number.isFinite),latest=entries[latestIndex],mean=measured.reduce((a,b)=>a+b,0)/count,total=measured.reduce((a,b)=>a+b,0),isTotal=['sum','count','union'].includes(metric.method),key=metric.type;
  const group=groups.get(key)||{type:key,label:metric.typeLabel||metric.label.split(' · ')[0],metrics:[],search:[]};groups.set(key,group);group.search.push(metric.label,metric.unit||'');
  const min=Math.min(0,...measured),method=methodLabels[metric.method]||'每日汇总';
  group.metrics.push(`<section class="panel health-metric-card" data-health-channel="${esc(metric.id)}"><div class="panel-head"><h3>${esc(metric.label)} <span class="tiny">${esc(metric.unit||'无单位')}</span></h3><span class="tiny">${count} / ${dates.length} 天</span></div><div class="panel-body"><div class="health-metric-summary"><span>最近 <strong>${num(latest,2)} ${esc(metric.unit||'')}</strong><span class="tiny"> · ${esc(dates[latestIndex])}</span></span><span class="tiny">${isTotal?'期间合计':'期间日均'} ${num(isTotal?total:mean,2)} ${esc(metric.unit||'')}</span></div><p class="tiny">${esc(method)}${metric.kind==='category'?' · 分类状态分别统计':''}${metric.method==='sum'?' · 采用当日覆盖最完整的来源':''}</p></div><div class="chart-wrap">${chart([{values:entries,color:metric.kind==='category'?'#8f79b7':'#438ec8',area:isTotal}],{height:190,xLabels:dates.map(d=>d.slice(5)),ylabel:metric.unit||'',min})}</div></section>`);
 }
 const sorted=[...groups.values()].sort((a,b)=>a.label.localeCompare(b.label,'zh-CN'));
 if(!sorted.length)return '';
 return `<section class="health-additional-charts" data-health-chart-browser><div class="health-chart-toolbar"><div><h2>${includeLegacy?'导入指标图表预览':'全部健康指标'}</h2><p class="tiny">${sorted.length} 类 · ${[...groups.values()].reduce((n,g)=>n+g.metrics.length,0)} 个图表。展开类型查看；分类状态和不同单位分别绘图。</p></div><label class="field">查找指标<input type="search" data-health-chart-search aria-label="查找健康图表" placeholder="输入名称或类型…"></label><button class="btn small" type="button" data-health-expand>展开全部</button><button class="btn small" type="button" data-health-collapse>收起全部</button></div>${sorted.map((group,index)=>`<details class="health-chart-group" data-health-chart-group data-search="${esc((group.label+' '+group.type+' '+group.search.join(' ')).toLowerCase())}" ${index<2?'open':''}><summary><strong>${esc(group.label)}</strong><span class="tiny">${group.metrics.length} 个图表</span></summary><div class="grid-2">${group.metrics.join('')}</div></details>`).join('')}<p class="tiny health-chart-empty" hidden>没有匹配的健康指标。</p></section>`;
}
if(typeof document!=='undefined'){
 document.addEventListener('input',event=>{if(!event.target.matches('[data-health-chart-search]'))return;const root=event.target.closest('[data-health-chart-browser]'),query=event.target.value.trim().toLowerCase();let shown=0;for(const group of root.querySelectorAll('[data-health-chart-group]')){group.hidden=query&&!group.dataset.search.includes(query);if(!group.hidden){shown++;if(query)group.open=true;}}root.querySelector('.health-chart-empty').hidden=shown>0;});
 document.addEventListener('click',event=>{const button=event.target.closest('[data-health-expand],[data-health-collapse]');if(!button)return;for(const group of button.closest('[data-health-chart-browser]').querySelectorAll('[data-health-chart-group]'))if(!group.hidden)group.open=button.hasAttribute('data-health-expand');});
}
export function wellnessTrendView(ctx){
 const {records=[],activities=[],range=90,end,esc,chart,num}=ctx;
 const days=[30,90,180,365].includes(Number(range))?Number(range):90;
 const from=new Date(Date.parse(end)-(days-1)*DAY).toISOString().slice(0,10);
 const data=wellnessTrends(records,activities,{from,to:end}),labels=data.daily.map(row=>row.date.slice(5)),display=(value,d=1)=>value===null?'—':num(value,d);
 const panels=Object.entries(wellnessMetrics).map(([key,meta])=>{
  const raw=data.daily.map(row=>row[key]),means=data.daily.map(row=>row.mean7[key]),summary=data.summary[key],measured=[...raw,...means].filter(Number.isFinite);
  const min=key==='weight'&&measured.length?Math.max(0,Math.min(...measured)*.98):0;
  return `<section class="panel"><div class="panel-head"><h3>${meta.label} <span class="tiny">${meta.unit}</span></h3><span class="tiny">${summary.count} / ${days} 天有记录</span></div><div class="panel-body"><div style="display:flex;justify-content:space-between;gap:14px;flex-wrap:wrap"><span>最近记录 <strong>${display(summary.latest)} ${meta.unit}</strong><span class="tiny"> · ${esc(summary.valueDate||'无记录')}</span></span><span class="tiny">期间均值 ${display(summary.mean)} ${meta.unit}</span></div></div><div class="chart-wrap">${measured.length?chart([{values:raw,color:'#438ec8'},{values:means,color:'#9b74b7'}],{height:210,xLabels:labels,ylabel:meta.unit,min}):'<p class="section-caption" style="padding:24px">该范围没有有效记录。</p>'}</div></section>`;
 }).join('');
 return `<section style="margin-bottom:20px"><div class="actions" style="margin-bottom:16px"><label class="field">趋势范围<select id="wellness-trend-range" aria-label="健康趋势范围">${[30,90,180,365].map(n=>`<option value="${n}" ${n===days?'selected':''}>近 ${n} 天</option>`).join('')}</select></label><label class="field">统计截止<input type="date" id="wellness-trend-end" aria-label="健康趋势统计截止" min="1901-01-01" max="2200-12-31" value="${esc(end)}"></label><div class="legend"><span><i style="background:#438ec8"></i>当日记录</span><span><i style="background:#9b74b7"></i>7 日均值（基础指标）</span></div></div><p class="tooltip-hint">${esc(from)} – ${esc(end)}</p><div class="grid-2">${panels}<section class="panel"><div class="panel-head"><h3>已完成训练负荷</h3><span class="tiny">${data.training.days} 个训练日 · 总负荷 ${num(data.training.totalLoad)}</span></div><div class="chart-wrap">${chart([{values:data.daily.map(row=>row.load),color:'#3c9b89',area:true}],{height:210,xLabels:labels,ylabel:'训练负荷',min:0})}</div><p class="panel-body tiny">已完成活动的每日训练负荷。</p></section></div>${healthChartGroups({records,from,to:end,esc,chart,num})}</section>`;
}
