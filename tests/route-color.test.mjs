import test from 'node:test';
import assert from 'node:assert/strict';
import {routePoints,routeStrokeLayers,routeSpeedColor,ROUTE_SPEED_BANDS,ROUTE_MISSING_COLOR,routeGradientStops} from '../src/route-geometry.mjs';

test('continuous speed scale uses SI input, interpolates anchors and preserves missing',()=>{
 for(const band of ROUTE_SPEED_BANDS)assert.equal(routeSpeedColor(band.min/3.6),band.color);
 assert.equal(routeSpeedColor(6/3.6),'#0b78ad');
 assert.notEqual(routeSpeedColor(20/3.6),routeSpeedColor(21/3.6));
 assert.equal(routeSpeedColor(100),ROUTE_SPEED_BANDS.at(-1).color);
 for(const n of [undefined,null,NaN,-1])assert.equal(routeSpeedColor(n),ROUTE_MISSING_COLOR);
 const stops=routeGradientStops(0,60/3.6);assert.equal(stops.length,6);assert.deepEqual(stops.map(x=>x.color),ROUTE_SPEED_BANDS.map(x=>x.color));
 assert.deepEqual(routeGradientStops(60/3.6,0).map(s=>s.color),ROUTE_SPEED_BANDS.map(x=>x.color).reverse());
});

test('dense route compiles one underlay followed by visible colored paths and supports single-color mode',()=>{
 const rows=Array.from({length:12000},(_,i)=>({time:i/10,lat:31+.005*Math.sin(i/1900),lon:121+.01*Math.cos(i/1900),speed:(6+12*Math.floor(i/2000))/3.6}));
 const before=structuredClone(rows),points=routePoints(rows),position=p=>({x:p.x*1000,y:p.y*1000});
 const layers=routeStrokeLayers(points,position);
 assert.ok(points.length<3010);
 assert.equal(layers.colors.length,6);
 assert.equal(layers.gradients.length,5);
 assert.equal((layers.halo.match(/M/g)||[]).length,points.length-1);
 assert.equal(layers.colors.reduce((count,path)=>count+(path.d.match(/M/g)||[]).length,0)+layers.gradients.length,points.length-1);
 assert.ok(layers.gradients.every(g=>g.stops.length>=2));
 assert.equal(routeStrokeLayers(points,position,'single').colors.length,1);
 assert.deepEqual(rows,before);
});

test('downsampling preserves original coordinate gaps and does not invent time-gap breaks',()=>{
 const rows=Array.from({length:10000},(_,i)=>({time:i*30,lat:31,lon:121+i/100000,speed:8}));
 for(let i=5001;i<rows.length;i++)rows[i].time+=90;
 const points=routePoints(rows),layers=routeStrokeLayers(points,p=>({x:p.time,y:p.lat}));
 const beforeGap=points.find(p=>p.time===rows[5000].time),afterGap=points.find(p=>p.time===rows[5001].time);
 assert.ok(beforeGap&&afterGap);
 assert.notEqual(beforeGap._routeSegment,afterGap._routeSegment);
 // Display stride is 4 (120 seconds). It must retain all continuous segments
 // despite that display interval being greater than the true gap threshold.
 assert.equal((layers.halo.match(/M/g)||[]).length,points.length-2);
 const original=[{time:0,x:0,y:0,speed:8},{time:90,x:1,y:1,speed:8}];
 assert.equal(routeStrokeLayers(original,p=>p).halo,'');
});

test('missing speed and paused endpoints stay grey instead of inventing a gradient',()=>{
 const points=[{time:0,x:0,y:0,speed:0},{time:1,x:1,y:1,speed:10},{time:2,x:2,y:2},{time:3,x:3,y:3,speed:12,timerActive:false}];
 const l=routeStrokeLayers(points,p=>p);assert.equal(l.gradients.length,1);assert.deepEqual(l.colors.map(p=>p.color),[ROUTE_MISSING_COLOR]);
 assert.equal(routeStrokeLayers(points,p=>p,'single').gradients.length,0);
});
