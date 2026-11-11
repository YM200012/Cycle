import {mkdir,readFile,writeFile,rename,stat,readdir,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
const PNG=Buffer.from([137,80,78,71,13,10,26,10]);
const MAX_BYTES=1024*1024,MIN_AGE=7*86400000,MAX_FILES=2000;
const error=(status,message)=>Object.assign(Error(message),{status});
export function validTile(z,x,y){return [z,x,y].every(Number.isInteger)&&z>=0&&z<=17&&x>=0&&y>=0&&x<2**z&&y<2**z;}
const crc32=data=>{let crc=0xffffffff;for(const b of data){crc^=b;for(let j=0;j<8;j++)crc=crc&1?(crc>>>1)^0xedb88320:crc>>>1;}return (crc^0xffffffff)>>>0;};
export function validTilePng(data){if(data.length<57||data.length>MAX_BYTES||!data.subarray(0,8).equals(PNG))return false;let offset=8,idat=false,header=false;while(offset+12<=data.length){const size=data.readUInt32BE(offset),type=data.toString('ascii',offset+4,offset+8);if(size>MAX_BYTES||offset+size+12>data.length)return false;if(crc32(data.subarray(offset+4,offset+8+size))!==data.readUInt32BE(offset+8+size))return false;if(!header){if(type!=='IHDR'||size!==13||data.readUInt32BE(offset+8)!==256||data.readUInt32BE(offset+12)!==256)return false;header=true;}if(type==='IDAT')idat=true;if(type==='IEND')return idat&&size===0&&offset+12===data.length;offset+=size+12;}return false;}
/** Validate baseline/progressive JPEG structure, dimensions, scan and end marker. */
export function validTileJpeg(data){
 if(data.length<20||data.length>MAX_BYTES||data[0]!==255||data[1]!==216)return false;
 let pos=2,header=false,scan=false;
 while(pos<data.length){
  if(data[pos++]!==255)return false;
  while(data[pos]===255)pos++;
  const marker=data[pos++];
  if(marker===217)return header&&scan&&pos===data.length;
  if(marker===0||marker===216||marker===undefined)return false;
  if(marker>=208&&marker<=215)continue;
  if(pos+2>data.length)return false;
  const length=data.readUInt16BE(pos);if(length<2||pos+length>data.length)return false;
  if([192,193,194].includes(marker)){
   if(length<8||data.readUInt16BE(pos+3)!==256||data.readUInt16BE(pos+5)!==256)return false;header=true;
  }
  pos+=length;
  if(marker===218){scan=true;let found=false;while(pos<data.length-1){if(data[pos]===255){const next=data[pos+1];if(next===0||next>=208&&next<=215){pos+=2;continue;}if(next===255){pos++;continue;}found=true;break;}pos++;}if(!found)return false;}
 }
 return false;
}
const tileType=data=>validTilePng(data)?'image/png':validTileJpeg(data)?'image/jpeg':null;
/** Fixed providers only; visible viewport requests after opt-in, separate caches. */
export function createMapTileStore(dataDir,{fetcher=globalThis.fetch}={}){
 const dir=join(dataDir,'map-tiles'),pending=new Map();let active=0;
 async function capacity(){let files;try{files=await readdir(dir);}catch{return;}const png=files.filter(f=>/^(?:opentopo-\d+-\d+-\d+\.png|lightgray-\d+-\d+-\d+\.tile)$/.test(f));if(png.length<MAX_FILES)return;const old=await Promise.all(png.map(async name=>({name,...await stat(join(dir,name))})));old.sort((a,b)=>a.mtimeMs-b.mtimeMs);let count=png.length;for(const row of old){if(count<MAX_FILES)break;if(Date.now()-row.mtimeMs<MIN_AGE)break;await unlink(join(dir,row.name)).catch(()=>{});await unlink(join(dir,row.name+'.json')).catch(()=>{});count--;}if(count>=MAX_FILES)throw error(507,'本地地图缓存已满，请稍后重试');}
 async function load(z,x,y,online,style='topo'){if(!['topo','light'].includes(style))throw error(400,'底图样式无效');if(!validTile(z,x,y))throw error(400,'地图瓦片坐标无效');const key=style==='light'?`lightgray-${z}-${x}-${y}.tile`:`opentopo-${z}-${x}-${y}.png`,path=join(dir,key);let cached,metadata={};try{cached=await readFile(path);if(!tileType(cached))cached=null;else{try{metadata=JSON.parse(await readFile(path+'.json','utf8'));}catch{} }}catch{}
  if(cached&&!Number.isFinite(metadata.expires)){const info=await stat(path);metadata.expires=info.mtimeMs+MIN_AGE;}
  if(cached&&(!online||metadata.expires>Date.now()))return {data:cached,contentType:tileType(cached),cached:true};
  if(!online){if(cached)return {data:cached,contentType:tileType(cached),cached:true};throw error(404,'此区域暂无离线底图');}
  if(pending.has(key))return pending.get(key);
  if(active>=6){if(cached)return {data:cached,contentType:tileType(cached),cached:true};throw error(429,'地图加载繁忙，请重试');}
  const task=(async()=>{active++;try{const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),10000);let response,bytes;try{response=await fetcher(style==='light'?`https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/${z}/${y}/${x}`:`https://a.tile.opentopomap.org/${z}/${x}/${y}.png`,{signal:controller.signal,redirect:'error',headers:{'User-Agent':'CycleLocal/0.9.1 (personal offline training desktop app)','Accept':'image/png,image/jpeg'}});if(!response.ok)throw error(502,'底图服务暂时不可用');if(Number(response.headers.get('content-length'))>MAX_BYTES)throw error(502,'底图数据过大');const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>MAX_BYTES){controller.abort();throw error(502,'底图数据过大');}chunks.push(chunk);}bytes=Buffer.concat(chunks);}finally{clearTimeout(timeout);}if(!tileType(bytes))throw error(502,'底图返回的图像无效');if(/no-store|no-cache/i.test(response.headers.get('cache-control')||'')){if(cached){await unlink(path).catch(()=>{});await unlink(path+'.json').catch(()=>{});}cached=null;throw error(502,'底图服务返回不可缓存的响应，暂不显示此瓦片');}await mkdir(dir,{recursive:true});if(!cached)await capacity();const cacheControl=response.headers.get('cache-control')||'',maxAge=/max-age=(\d+)/i.exec(cacheControl),expires=maxAge?Date.now()+Number(maxAge[1])*1000:Date.parse(response.headers.get('expires'))||Date.now()+MIN_AGE,temp=path+'.'+randomUUID()+'.tmp';await writeFile(temp,bytes);await rename(temp,path);await writeFile(path+'.json',JSON.stringify({expires}));return {data:bytes,contentType:tileType(bytes),cached:false};}catch(e){if(cached)return {data:cached,contentType:tileType(cached),cached:true,stale:true};if(e.status)throw e;throw error(502,'底图连接失败，可继续查看本地轨迹');}finally{active--;pending.delete(key);}})();pending.set(key,task);return task;
 }
 return {get:load};
}
