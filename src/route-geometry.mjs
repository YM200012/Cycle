const MAX_LAT=85.0511287798066;
export const ROUTE_SPEED_BANDS=[
 {min:0,color:'#1565c0',label:'0–12'},
 {min:12,color:'#008b9a',label:'12–24'},
 {min:24,color:'#218b48',label:'24–36'},
 {min:36,color:'#d28d00',label:'36–48'},
 {min:48,color:'#dc5d21',label:'48–60'},
 {min:60,color:'#be3156',label:'60+'}
];
export const ROUTE_MISSING_COLOR='#687d8a';
/** Input speed is always SI m/s; zero is a measured low speed, not missing. */
export function routeSpeedColor(speed){
 if(!Number.isFinite(speed)||speed<0)return ROUTE_MISSING_COLOR;
 const kmh=speed*3.6,knots=ROUTE_SPEED_BANDS;
 for(let i=1;i<knots.length;i++)if(kmh<knots[i].min){const a=knots[i-1],b=knots[i],t=(kmh-a.min)/(b.min-a.min);return '#'+[1,3,5].map(k=>Math.round(parseInt(a.color.slice(k,k+2),16)*(1-t)+parseInt(b.color.slice(k,k+2),16)*t).toString(16).padStart(2,'0')).join('');}
 return knots.at(-1).color;
}
export function routeGradientStops(from,to){
 const stops=[{offset:0,color:routeSpeedColor(from)}];
 if(from!==to)for(const band of ROUTE_SPEED_BANDS){const offset=(band.min/3.6-from)/(to-from);if(offset>0&&offset<1)stops.push({offset,color:band.color});}
 stops.push({offset:1,color:routeSpeedColor(to)});return stops.sort((a,b)=>a.offset-b.offset);
}
export const wrapTile=(x,z)=>((x%2**z)+2**z)%2**z;
export function project(lat,lon){const bounded=Math.max(-MAX_LAT,Math.min(MAX_LAT,lat)),sin=Math.sin(bounded*Math.PI/180);return {x:(lon+180)/360,y:.5-Math.log((1+sin)/(1-sin))/(4*Math.PI)};}
export function routePoints(streams=[]){
 const points=[];let lastX,lastTime,segment=0;
 for(const s of streams){
  if(!Number.isFinite(s.lat)||!Number.isFinite(s.lon)||Math.abs(s.lat)>90||Math.abs(s.lon)>180||!Number.isFinite(s.time))continue;
  if(lastTime!==undefined&&(s.time-lastTime>60||s.time<=lastTime))segment++;
  const p=project(s.lat,s.lon);if(lastX!==undefined)p.x+=Math.round(lastX-p.x);lastX=p.x;lastTime=s.time;
  points.push({...s,...p,_routeSegment:segment});
 }
 const stride=Math.max(1,Math.ceil(points.length/3000));
 // Keep gap boundaries in addition to regular display samples. Segment IDs
 // describe original continuity, rather than the artificial display stride.
 return points.filter((p,i)=>i%stride===0||i===points.length-1||points[i-1]?._routeSegment!==p._routeSegment||points[i+1]?._routeSegment!==p._routeSegment);
}
/** Build all white underlay paths first, then colored overlays. Never interleave
 * underlays with short colored segments: their round caps erase earlier colors. */
export function routeStrokeLayers(points,position,colorMode='speed'){
 const colors=new Map(),gradients=[];let halo='';
 for(let i=1;i<points.length;i++){
  const previous=points[i-1],point=points[i];
  if(previous._routeSegment!==point._routeSegment)continue;
  // Direct callers may supply original points without routePoints metadata.
  if(previous._routeSegment===undefined&&(point.time<=previous.time||point.time-previous.time>60))continue;
  const a=position(previous),b=position(point);
  const d=`M${a.x.toFixed(2)},${a.y.toFixed(2)}L${b.x.toFixed(2)},${b.y.toFixed(2)} `;
  const color=colorMode==='single'?'#1565c0':routeSpeedColor(previous.timerActive===false?undefined:previous.speed);
  halo+=d;
  const endColor=routeSpeedColor(point.timerActive===false?undefined:point.speed);
  if(colorMode==='speed'&&color!==ROUTE_MISSING_COLOR&&endColor!==ROUTE_MISSING_COLOR&&color!==endColor)
   gradients.push({a,b,d,stops:routeGradientStops(previous.speed,point.speed)});
  else {const solid=colorMode==='speed'&&(color===ROUTE_MISSING_COLOR||endColor===ROUTE_MISSING_COLOR)?ROUTE_MISSING_COLOR:color;colors.set(solid,(colors.get(solid)||'')+d);}
 }
 return {halo,gradients,colors:[...colors].map(([color,d])=>({color,d}))};
}
export function fitRoute(points,width=1000,height=460){if(!points.length)return {x:.5,y:.5,zoom:2};let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;for(const p of points){minX=Math.min(minX,p.x);maxX=Math.max(maxX,p.x);minY=Math.min(minY,p.y);maxY=Math.max(maxY,p.y);}const zoom=Math.max(2,Math.min(17,Math.floor(Math.log2(Math.min((width-100)/Math.max(maxX-minX,1e-8),(height-100)/Math.max(maxY-minY,1e-8))/256))));return {x:(minX+maxX)/2,y:(minY+maxY)/2,zoom};}
export function visibleTiles(view,width=1000,height=460){const n=2**view.zoom,scale=256*n,left=view.x*scale-width/2,top=view.y*scale-height/2,tiles=[];for(let y=Math.floor(top/256);y<=Math.floor((top+height)/256);y++){if(y<0||y>=n)continue;for(let x=Math.floor(left/256);x<=Math.floor((left+width)/256);x++)tiles.push({z:view.zoom,x:wrapTile(x,view.zoom),y,left:x*256-left,top:y*256-top});}return tiles;}
