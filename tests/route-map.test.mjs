import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {deflateSync} from 'node:zlib';
import {project,routePoints,fitRoute,visibleTiles,wrapTile} from '../src/route-geometry.mjs';
import {createMapTileStore,validTile,validTilePng} from '../src/map-tiles.mjs';
const crc32=data=>{let c=0xffffffff;for(const b of data){c^=b;for(let j=0;j<8;j++)c=c&1?(c>>>1)^0xedb88320:c>>>1;}return(c^0xffffffff)>>>0;};
function png(){const chunk=(type,data)=>{const b=Buffer.alloc(data.length+12);b.writeUInt32BE(data.length);b.write(type,4);data.copy(b,8);b.writeUInt32BE(crc32(b.subarray(4,b.length-4)),b.length-4);return b;},header=Buffer.alloc(13);header.writeUInt32BE(256);header.writeUInt32BE(256,4);header[8]=8;header[9]=2;return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.alloc((256*3+1)*256))),chunk('IEND',Buffer.alloc(0))]);}
test('map projection keeps antimeridian routes local, bounds poles, and fits the viewport',()=>{
 assert.deepEqual(project(0,0),{x:.5,y:.5});assert.ok(project(90,0).y>=-1e-12);assert.ok(project(-90,0).y<=1+1e-12);
 const rows=routePoints([{time:0,lat:20,lon:179.9},{time:5,lat:20.1,lon:-179.9},{time:7,lat:100,lon:0},{time:10,lat:20.2,lon:-179.8}]);assert.equal(rows.length,3);assert.ok(Math.abs(rows[1].x-rows[0].x)<.01);const view=fitRoute(rows);assert.ok(view.zoom>2);const tiles=visibleTiles(view);assert.ok(tiles.length<=24);assert.ok(tiles.every(t=>validTile(t.z,t.x,t.y)));assert.equal(wrapTile(-1,2),3);assert.deepEqual(fitRoute([]),{x:.5,y:.5,zoom:2});
});
test('tile validation rejects arbitrary coordinates, non-PNG and corrupt image chunks',()=>{
 assert.ok(validTile(17,1,1));for(const values of [[18,1,1],[3,-1,1],[3,8,1],[3,1.5,1],[NaN,1,1]])assert.equal(validTile(...values),false);const data=png();assert.ok(validTilePng(data));assert.equal(validTilePng(Buffer.from('<html>not a tile</html>')),false);const corrupted=Buffer.from(data);corrupted[30]^=1;assert.equal(validTilePng(corrupted),false);assert.equal(validTilePng(data.subarray(0,24)),false);
});
test('map tile store is offline by default, persists only verified requested tiles, and reuses cache',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'cycle-map-'));let requests=0;const store=createMapTileStore(dir,{fetcher:async url=>{requests++;assert.equal(url,'https://a.tile.opentopomap.org/3/4/2.png');return new Response(png(),{headers:{'Content-Type':'image/png','Cache-Control':'max-age=604800'}});}});try{await assert.rejects(store.get(3,4,2,false),{status:404});assert.equal(requests,0);await assert.rejects(store.get(99,1,1,true),{status:400});const [first,duplicate]=await Promise.all([store.get(3,4,2,true),store.get(3,4,2,true)]);assert.equal(requests,1);assert.equal(first.cached,false);assert.deepEqual(first.data,duplicate.data);assert.equal((await store.get(3,4,2,false)).cached,true);assert.equal((await store.get(3,4,2,true)).cached,true);const freshStore=createMapTileStore(dir,{fetcher:()=>{throw Error('must use cache');}});assert.deepEqual((await freshStore.get(3,4,2,false)).data,png());assert.equal((await readdir(join(dir,'map-tiles'))).filter(f=>f.endsWith('.png')).length,1);}finally{await rm(dir,{recursive:true,force:true});}
});
test('invalid provider responses do not poison cache and no-store is honored',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'cycle-map-invalid-'));try{const bad=createMapTileStore(dir,{fetcher:async()=>new Response('not png')});await assert.rejects(bad.get(3,4,2,true),{status:502});await assert.rejects(bad.get(3,4,2,false),{status:404});let calls=0;const store=createMapTileStore(dir,{fetcher:async()=>{calls++;return new Response(png(),{headers:{'Cache-Control':'no-store'}});}});await assert.rejects(store.get(3,4,2,true),{status:502});await assert.rejects(store.get(3,4,2,true),{status:502});assert.equal(calls,2);await assert.rejects(store.get(3,4,2,false),{status:404});}finally{await rm(dir,{recursive:true,force:true});}
});

test('minimal light basemap uses its fixed provider and isolated mixed-image cache',async()=>{
 const {readFile}=await import('node:fs/promises');
 const {validTileJpeg}=await import('../src/map-tiles.mjs');
 const jpeg=await readFile(new URL('./fixtures/esri-light-gray-sample.jpg',import.meta.url));
 assert.ok(validTileJpeg(jpeg));assert.equal(validTileJpeg(jpeg.subarray(0,jpeg.length-2)),false);assert.equal(validTileJpeg(png()),false);
 const badSize=Buffer.from(jpeg);const sof=badSize.indexOf(Buffer.from([255,192]));assert.ok(sof>0);badSize[sof+6]^=1;assert.equal(validTileJpeg(badSize),false);
 const dir=await mkdtemp(join(tmpdir(),'cycle-map-styles-')),urls=[];
 const store=createMapTileStore(dir,{fetcher:async url=>{urls.push(url);return new Response(url.includes('arcgisonline')?jpeg:png(),{headers:{'Cache-Control':'max-age=604800'}});}});
 try{
  await assert.rejects(store.get(3,4,2,false,'light'),{status:404});
  const light=await store.get(3,4,2,true,'light');assert.equal(light.contentType,'image/jpeg');assert.equal(urls[0],'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/3/2/4');
  await assert.rejects(store.get(3,4,2,false,'topo'),{status:404});
  const topo=await store.get(3,4,2,true,'topo');assert.equal(topo.contentType,'image/png');
  assert.deepEqual((await store.get(3,4,2,false,'light')).data,jpeg);assert.equal(urls.length,2);
  await assert.rejects(store.get(3,4,2,true,'https://example.org'),{status:400});assert.equal(urls.length,2);
  const offline=createMapTileStore(dir,{fetcher:()=>{throw Error('offline');}});assert.deepEqual((await offline.get(3,4,2,false,'light')).data,jpeg);
 }finally{await rm(dir,{recursive:true,force:true});}
});
