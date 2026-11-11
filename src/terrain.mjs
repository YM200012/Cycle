import {inflateSync} from 'node:zlib';
import {mkdir,readFile,writeFile,rename,readdir,stat,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {validTilePng} from './map-tiles.mjs';
import {project,wrapTile} from './route-geometry.mjs';
import {ELEVATION_SOURCE} from './elevation.mjs';
const fail=(status,message)=>Object.assign(Error(message),{status});
const ZOOM=12,N=2**ZOOM,WORLD=N*256,MAX_BYTES=1024*1024;
export function decodeTerrarium(bytes){
 if(!validTilePng(bytes)||bytes[24]!==8||![2,6].includes(bytes[25])||bytes[28]!==0)throw fail(502,'地形瓦片格式无效');
 const channels=bytes[25]===2?3:4,stride=256*channels,chunks=[];
 for(let pos=8;pos<bytes.length;){const size=bytes.readUInt32BE(pos);if(bytes.toString('ascii',pos+4,pos+8)==='IDAT')chunks.push(bytes.subarray(pos+8,pos+8+size));pos+=size+12;}
 const scan=inflateSync(Buffer.concat(chunks),{maxOutputLength:(stride+1)*256});if(scan.length!==(stride+1)*256)throw fail(502,'地形瓦片解码失败');
 const decoded=new Uint8Array(stride*256),heights=new Float32Array(256*256);
 const paeth=(a,b,c)=>{const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);return pa<=pb&&pa<=pc?a:pb<=pc?b:c;};
 for(let y=0;y<256;y++){const filter=scan[y*(stride+1)];if(filter>4)throw fail(502,'地形瓦片滤波无效');for(let x=0;x<stride;x++){const i=y*stride+x,a=x>=channels?decoded[i-channels]:0,b=y?decoded[i-stride]:0,c=y&&x>=channels?decoded[i-stride-channels]:0,v=scan[y*(stride+1)+1+x];decoded[i]=(v+(filter===1?a:filter===2?b:filter===3?Math.floor((a+b)/2):filter===4?paeth(a,b,c):0))&255;}
 for(let x=0;x<256;x++){const i=y*stride+x*channels;heights[y*256+x]=channels===4&&decoded[i+3]===0?NaN:decoded[i]*256+decoded[i+1]+decoded[i+2]/256-32768;}}
 return heights;
}
export function terrainPixels(row){
 if(!Number.isFinite(row.lat)||!Number.isFinite(row.lon)||Math.abs(row.lat)>85.05112878||Math.abs(row.lon)>180)return null;
 const p=project(row.lat,row.lon),gx=((p.x*WORLD-.5)%WORLD+WORLD)%WORLD,gy=Math.max(0,Math.min(WORLD-1,p.y*WORLD-.5)),x=Math.floor(gx),y=Math.floor(gy),fx=gx-x,fy=gy-y;
 return [[x,y,(1-fx)*(1-fy)],[x+1,y,fx*(1-fy)],[x,y+1,(1-fx)*fy],[x+1,y+1,fx*fy]].filter(p=>p[2]>0).map(([x,y,w])=>({x:wrapTile(Math.floor(x/256),ZOOM),y:Math.min(N-1,Math.floor(y/256)),pixel:Math.min(255,y%256)*256+x%256,w}));
}
export function createTerrainStore(dataDir,{fetcher=globalThis.fetch}={}){
 const dir=join(dataDir,'terrain-tiles'),pending=new Map();
 async function tile(x,y,online){
  const key=`terrarium-${ZOOM}-${x}-${y}.png`,path=join(dir,key);try{return decodeTerrarium(await readFile(path));}catch{}
  if(!online)throw fail(404,'此路线地形尚未缓存，请联网校正一次');
  if(pending.has(key))return pending.get(key);
  const task=(async()=>{try{const response=await fetcher(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${ZOOM}/${x}/${y}.png`,{signal:AbortSignal.timeout(15000),redirect:'error'});if(!response.ok)throw fail(502,'地形服务暂时不可用');if(/no-store|no-cache/i.test(response.headers.get('cache-control')||''))throw fail(502,'地形服务暂不允许缓存');
   const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>MAX_BYTES)throw fail(502,'地形瓦片过大');chunks.push(chunk);}const bytes=Buffer.concat(chunks),data=decodeTerrarium(bytes);await mkdir(dir,{recursive:true});const files=(await readdir(dir)).filter(f=>/^terrarium-12-\d+-\d+\.png$/.test(f));if(files.length>=2048){const ages=await Promise.all(files.map(async name=>({name,time:(await stat(join(dir,name))).mtimeMs})));ages.sort((a,b)=>a.time-b.time);for(const f of ages.slice(0,16))await unlink(join(dir,f.name)).catch(()=>{});}
   const temp=path+'.'+randomUUID()+'.tmp';await writeFile(temp,bytes);await rename(temp,path);return data;
  }catch(e){if(e.status)throw e;throw fail(502,'地形下载或解码失败；原海拔未修改');}finally{pending.delete(key);}})();pending.set(key,task);return task;
 }
 async function correct(activity,{online=false}={}){
  if(activity.planned)throw fail(400,'训练计划不能校正地形海拔');
  const rows=(activity.streams||[]).map(row=>({row,pixels:terrainPixels(row)})).filter(p=>p.pixels),keys=new Map();
  for(const p of rows)for(const q of p.pixels)keys.set(`${q.x}/${q.y}`,q);
  if(!rows.length)throw fail(400,'没有可用于地形高程查询的 GPS 路线');if(keys.size>128)throw fail(400,'路线覆盖超过 128 块地形瓦片，请先按活动分段导入');
  const entries=[...keys],data=new Map();let index=0;
  await Promise.all(Array.from({length:Math.min(4,entries.length)},async()=>{while(index<entries.length){const [key,p]=entries[index++];data.set(key,await tile(p.x,p.y,online));}}));
  const points=[];for(const {row,pixels}of rows){let height=0,valid=true;for(const p of pixels){const v=data.get(`${p.x}/${p.y}`)[p.pixel];if(!Number.isFinite(v)||v< -500||v>10000){valid=false;break;}height+=v*p.w;}if(valid)points.push({time:row.time,lat:row.lat,lon:row.lon,altitude:Math.round(height*10)/10});}
  if(!points.length)throw fail(422,'此路线没有有效地形高程，原海拔未修改');
  return {source:ELEVATION_SOURCE,zoom:ZOOM,createdAt:new Date().toISOString(),points};
 }
 return {correct};
}
