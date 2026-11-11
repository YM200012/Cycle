let nextId=0;
const specs=new Map();
const clock=t=>{t=Math.max(0,Math.round(t));return `${Math.floor(t/3600)?Math.floor(t/3600)+':':''}${String(Math.floor(t/60)%60).padStart(2,'0')}:${String(t%60).padStart(2,'0')}`;};
/** Every full-size chart owns its visible range; resolvers re-sample original
 * measurements for that range instead of magnifying a pre-reduced SVG. */
export function zoomableChart(render){
 const observer=new MutationObserver(()=>{
  for(const root of document.querySelectorAll('[data-chart-view]')){
   const spec=specs.get(root.dataset.chartView);if(!spec||spec.root)continue;spec.root=root;mount(spec);
  }
  for(const [id,spec]of specs)if(spec.root&&!spec.root.isConnected){spec.dispose?.();specs.delete(id);}
 });observer.observe(document.documentElement,{subtree:true,childList:true});
 function mount(spec){
  const {root,series,options}=spec,full=options.xDomain||[0,Math.max(1,...series.map(s=>s.values.length-1))];let range=[...full],drag=null,box=null,lastWidth=0;
  const span=()=>range[1]-range[0];
  const budget=()=>Math.max(480,Math.min(1800,Math.round((root.clientWidth||900)*1.4)));
  function update(){
   const resolved=options.resolveRange?.({start:range[0],stop:range[1],budget:budget()});
   let current=series,opts={...options};
   if(resolved){current=resolved.series;opts={...opts,...resolved.options};}
   else if(options.xDomain){current=series.map(s=>{const indices=(s.times||[]).map((t,i)=>t>=range[0]&&t<=range[1]?i:-1).filter(i=>i>=0);return {...s,values:indices.map(i=>s.values[i]),times:indices.map(i=>s.times[i])};});opts.xDomain=range;}
   else{const first=Math.max(0,Math.ceil(range[0])),last=Math.floor(range[1]);current=series.map(s=>({...s,values:s.values.slice(first,last+1)}));opts.xLabels=(options.xLabels||[]).slice(first,last+1);}
   const fullRange=Math.abs(range[0]-full[0])<1e-6&&Math.abs(range[1]-full[1])<1e-6;
   root.innerHTML=`<div class="chart-zoom-toolbar"><span data-chart-range>${options.xDomain?clock(range[0])+' – '+clock(range[1]):'拖选区间查看细节'}${fullRange?' · 全图':''}</span><div><button type="button" data-chart-zoom="in" aria-label="放大曲线">＋</button><button type="button" data-chart-zoom="out" aria-label="缩小曲线">−</button><button type="button" data-chart-zoom="reset">全图</button></div></div>${render(current,opts)}`;
   const svg=root.querySelector('svg.chart');if(svg){svg.tabIndex=0;svg.dataset.viewStart=range[0];svg.dataset.viewStop=range[1];svg.setAttribute('aria-description','拖动选择区间放大，双击恢复全图；Control 加滚轮缩放。');}
   root.dataset.visiblePoints=current.reduce((n,s)=>n+s.values.filter(Number.isFinite).length,0);root.dataset.rangeStart=range[0];root.dataset.rangeStop=range[1];
  }
  function apply(start,stop){const min=options.xDomain?Math.min(1,full[1]-full[0]):1,w=Math.min(full[1]-full[0],Math.max(min,stop-start));start=Math.max(full[0],Math.min(full[1]-w,start));range=[start,start+w];update();options.onRangeChange?.({start:range[0],stop:range[1]});}
  function zoom(factor,anchor=.5){const width=span()*factor,center=range[0]+span()*anchor;apply(center-width*anchor,center+width*(1-anchor));}
  const fraction=(event,svg)=>{const rect=svg.getBoundingClientRect(),x=(event.clientX-rect.left)/rect.width*920;return Math.max(0,Math.min(1,(x-48)/852));};
  root.addEventListener('click',e=>{const b=e.target.closest('[data-chart-zoom]');if(!b)return;e.stopPropagation();if(b.dataset.chartZoom==='reset'){range=[...full];update();options.onRangeChange?.({start:range[0],stop:range[1]});}else zoom(b.dataset.chartZoom==='in'?.5:2);});
  root.addEventListener('pointerdown',e=>{const svg=e.target.closest('svg.chart');if(!svg||e.button!==0)return;drag={id:e.pointerId,start:fraction(e,svg),svg};svg.setPointerCapture(e.pointerId);box=document.createElementNS('http://www.w3.org/2000/svg','rect');box.setAttribute('class','chart-zoom-selection');box.setAttribute('y',18);box.setAttribute('height',svg.viewBox.baseVal.height-53);svg.append(box);e.preventDefault();});
  root.addEventListener('pointermove',e=>{if(!drag)return;const end=fraction(e,drag.svg),x=Math.min(drag.start,end);box.setAttribute('x',48+x*852);box.setAttribute('width',Math.abs(end-drag.start)*852);});
  root.addEventListener('pointerup',e=>{if(!drag)return;const end=fraction(e,drag.svg),start=drag.start;drag=null;box?.remove();if(Math.abs(end-start)<.01)return;const old=[...range];apply(old[0]+Math.min(start,end)*(old[1]-old[0]),old[0]+Math.max(start,end)*(old[1]-old[0]));});
  root.addEventListener('pointercancel',()=>{drag=null;box?.remove();});
  root.addEventListener('dblclick',e=>{if(!e.target.closest('svg.chart'))return;range=[...full];update();options.onRangeChange?.({start:range[0],stop:range[1]});});
  root.addEventListener('wheel',e=>{const svg=e.target.closest('svg.chart');if(!svg||!e.ctrlKey)return;e.preventDefault();zoom(e.deltaY<0?.8:1.25,fraction(e,svg));},{passive:false});
  root.addEventListener('keydown',e=>{if(!e.target.matches('svg.chart'))return;if(['+','=','-','Home'].includes(e.key)){e.preventDefault();if(e.key==='Home'){range=[...full];update();options.onRangeChange?.({start:range[0],stop:range[1]});}else zoom(e.key==='-'?2:.5);}});
  const resize=new ResizeObserver(()=>{const width=root.clientWidth;if(Math.abs(width-lastWidth)<10)return;lastWidth=width;update();});resize.observe(root);spec.dispose=()=>resize.disconnect();update();
 }
 return (series,options={})=>{if(!series.some(s=>s.values.some(Number.isFinite)))return render(series,options);const id=String(++nextId);specs.set(id,{series,options});return `<div class="interactive-chart" data-chart-view="${id}">${render(series,options)}</div>`;};
}
