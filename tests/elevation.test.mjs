import test from 'node:test';
import assert from 'node:assert/strict';
import {deflateSync} from 'node:zlib';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {decodeTerrarium,createTerrainStore,terrainPixels} from '../src/terrain.mjs';
import {elevationActivity,normalizeElevation} from '../src/elevation.mjs';
import {rideDetails} from '../src/ride-details.mjs';
import {startServer} from '../src/server.mjs';
const crc32=data=>{let c=0xffffffff;for(const b of data){c^=b;for(let j=0;j<8;j++)c=c&1?(c>>>1)^0xedb88320:c>>>1;}return(c^0xffffffff)>>>0;};
function tile(filter=0){
 const chunk=(type,data)=>{const b=Buffer.alloc(data.length+12);b.writeUInt32BE(data.length);b.write(type,4);data.copy(b,8);b.writeUInt32BE(crc32(b.subarray(4,b.length-4)),b.length-4);return b;};
 const header=Buffer.alloc(13);header.writeUInt32BE(256);header.writeUInt32BE(256,4);header[8]=8;header[9]=2;
 const stride=768,raw=Buffer.alloc(stride*256),scan=Buffer.alloc((stride+1)*256);
 for(let y=0;y<256;y++)for(let x=0;x<256;x++){const i=y*stride+x*3;raw[i]=128;raw[i+1]=100;raw[i+2]=128;}
 const paeth=(a,b,c)=>{const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);return pa<=pb&&pa<=pc?a:pb<=pc?b:c;};
 for(let y=0;y<256;y++){scan[y*(stride+1)]=filter;for(let x=0;x<stride;x++){const i=y*stride+x,a=x>=3?raw[i-3]:0,b=y?raw[i-stride]:0,c=y&&x>=3?raw[i-stride-3]:0;scan[y*(stride+1)+x+1]=(raw[i]-(filter===1?a:filter===2?b:filter===3?Math.floor((a+b)/2):filter===4?paeth(a,b,c):0))&255;}}
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(scan)),chunk('IEND',Buffer.alloc(0))]);
}
const ride=()=>({name:'高程测试',date:'2026-11-10',type:'Ride',duration:1,distance:1,load:5,fitSummary:{ascent:999,minAltitude:888,maxAltitude:999},streams:Array.from({length:61},(_,time)=>({time,lat:31.2,lon:121.45+time*.00001,altitude:900+time,power:200,cadence:90,speed:8}))});
test('Terrarium PNG decoding handles all five PNG filters and fractional metres',()=>{
 for(let i=0;i<5;i++){const heights=decodeTerrarium(tile(i));assert.equal(heights.length,65536);assert.ok(heights.every(h=>h===100.5));}
 const bad=Buffer.from(tile());bad[60]^=1;assert.throws(()=>decodeTerrarium(bad));
});
test('terrain lookup bilinear weights sum to one, rejects invalid GPS and wraps date line',()=>{
 for(const r of [{lat:31.2,lon:121.4},{lat:0,lon:180},{lat:0,lon:-180}]){const p=terrainPixels(r);assert.ok(Math.abs(p.reduce((n,p)=>n+p.w,0)-1)<1e-8);assert.ok(p.every(p=>p.x>=0&&p.x<4096&&p.y>=0&&p.y<4096&&p.pixel>=0&&p.pixel<65536));}
 assert.equal(terrainPixels({lat:90,lon:0}),null);
});
test('route correction caches tiles offline and overlays without replacing original data or device elevations',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'cycle-terrain-'));let calls=0;
 const store=createTerrainStore(dir,{fetcher:async url=>{assert.match(url,/^https:\/\/s3.amazonaws.com\/elevation-tiles-prod\/terrarium\/12\//);calls++;return new Response(tile());}});
 try{const a=ride(),raw=JSON.stringify(a);await assert.rejects(store.correct(a),{status:404});const correction=await store.correct(a,{online:true});assert.ok(calls>0);assert.equal(correction.points.length,61);assert.ok(correction.points.every(p=>p.altitude===100.5));a.elevationCorrection=normalizeElevation(correction,a.streams);const displayed=elevationActivity(a);assert.equal(displayed.streams[0].altitude,100.5);assert.equal(displayed.fitSummary.ascent,undefined);assert.equal(rideDetails(a).metrics.ascent.value,0);delete a.elevationCorrection;assert.equal(JSON.stringify(a),raw);const offline=createTerrainStore(dir,{fetcher:()=>{throw Error('offline');}});assert.deepEqual((await offline.correct(a)).points,correction.points);assert.throws(()=>normalizeElevation({...correction,points:[{...correction.points[0],lon:0}]},a.streams));}finally{await rm(dir,{recursive:true,force:true});}
});
test('elevation API preserves raw FIT, round-trips backups, restores original and rejects stale query results',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'cycle-terrain-api-'));let unblock,started,gate=false;const entered=new Promise(r=>started=r);
 const server=await startServer({dataDir:dir,terrainFetcher:async()=>{if(gate){started();await new Promise(r=>unblock=r);}return new Response(tile());}});
 const api=async(path,method='GET',data)=>{const r=await fetch(server.url+'/api'+path,{method,...(data===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(data)})});return {status:r.status,data:await r.json()};};
 try{
 const a=(await api('/activities','POST',ride())).data;
 assert.equal((await api(`/activities/${a.id}/elevation-correction`,'POST',{online:false})).status,404);
 const corrected=await api(`/activities/${a.id}/elevation-correction`,'POST',{online:true});assert.equal(corrected.status,200);assert.deepEqual(corrected.data.streams,a.streams);assert.deepEqual(corrected.data.fitSummary,a.fitSummary);
 const backup=(await api('/backup')).data;assert.equal((await api('/restore','POST',backup)).status,200);assert.deepEqual((await api(`/activities/${a.id}`)).data.elevationCorrection,corrected.data.elevationCorrection);
 const restored=await api(`/activities/${a.id}/elevation-correction`,'DELETE');assert.equal(restored.data.elevationCorrection,undefined);assert.deepEqual(restored.data.streams,a.streams);
 const b=(await api('/activities','POST',{...ride(),streams:ride().streams.map(r=>({...r,lon:100}))})).data;gate=true;
 const pending=api(`/activities/${b.id}/elevation-correction`,'POST',{online:true});await entered;
 await api(`/activities/${b.id}`,'PUT',{...b,notes:'查询期间编辑'});gate=false;unblock();assert.equal((await pending).status,409);assert.equal((await api(`/activities/${b.id}`)).data.notes,'查询期间编辑');
 }finally{await server.close();await rm(dir,{recursive:true,force:true});}
});
