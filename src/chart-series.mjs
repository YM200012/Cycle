/** Display-only reduction. Keep extrema and actual timestamps, never average
 * away a sprint or connect pauses, missing measurements, or >30 s gaps. */
export function chartSeries(rows=[],key,{start=0,stop=rows.at(-1)?.time||0,budget=3600,factor=1,mode=key==='cadence'?'mean':'extrema'}={}) {
  const runs=[];let run=[],previous=null;
  const flush=()=>{if(run.length)runs.push(run);run=[];};
  for(const row of rows){
    if(!Number.isFinite(row.time)||row.time<start||row.time>stop)continue;
    if(previous!==null&&(row.time<=previous||row.time-previous>30))flush();
    previous=row.time;
    if(row.timerActive===false||!Number.isFinite(row[key])){flush();continue;}
    run.push({time:row.time,value:row[key]*factor});
  }
  flush();
  const count=runs.reduce((n,r)=>n+r.length,0),width=mode==='mean'?Math.max(5,(stop-start)/Math.max(1,Math.floor(budget/4))):(stop-start)/Math.max(1,Math.floor(budget/4));
  const selected=runs.map(r=>{
    if(!Number.isFinite(budget)||mode!=='mean'&&count<=budget||width<=0)return r;
    const out=[];let bucket=[],index=null;
    const emit=()=>{if(!bucket.length)return;if(mode==='mean'){out.push({time:bucket.reduce((n,p)=>n+p.time,0)/bucket.length,value:bucket.reduce((n,p)=>n+p.value,0)/bucket.length});return;}let min=bucket[0],max=min;for(const p of bucket){if(p.value<min.value)min=p;if(p.value>max.value)max=p;}out.push(...[...new Set([bucket[0],min,max,bucket.at(-1)])].sort((a,b)=>a.time-b.time));};
    for(const p of r){const i=Math.floor((p.time-start)/width);if(i!==index){emit();bucket=[];index=i;}bucket.push(p);}emit();return out;
  });
  const points=[];
  for(const r of selected){if(points.length)points.push({time:(points.at(-1).time+r[0].time)/2,value:null});for(const p of r)points.push(p);}
  return {values:points.map(p=>p.value),times:points.map(p=>p.time),rawCount:count,displayCount:points.filter(p=>p.value!==null).length};
}
