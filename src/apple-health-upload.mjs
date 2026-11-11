import {createReadStream} from 'node:fs';
import {spawn} from 'node:child_process';

export const MAX_HEALTH_BYTES=2*1024**3;
const fail=message=>Object.assign(Error(message),{status:400});

async function zipEntries(path){
 const child=spawn('/usr/bin/unzip',['-Z1',path],{stdio:['ignore','pipe','pipe']});
 let listing='',bytes=0,failed;
 child.on('error',error=>{failed=error;});
 child.stderr.resume();
 const ended=new Promise(resolve=>child.once('close',code=>resolve(code)));
 try{
  for await(const chunk of child.stdout){bytes+=chunk.length;if(bytes>4*1024*1024)throw fail('健康 ZIP 中的文件列表过大');listing+=chunk.toString('utf8');}
  const code=await ended;if(failed||code!==0)throw fail('无法读取健康 ZIP，请选择 iPhone 导出的完整 ZIP 或解压后的 XML');
  const entries=listing.split(/\r?\n/).filter(Boolean),xml=entries.filter(name=>/\.xml$/i.test(name)&&!/(?:^|\/)export_cda\.xml$/i.test(name));
  if(xml.length!==1)throw fail(xml.length?'ZIP 中有多个健康 XML，请解压后选择需要的 XML':'ZIP 中没有可读取的健康 XML（不支持 export_cda.xml）');
 }finally{if(child.exitCode===null&&!child.killed)child.kill();await ended;}
}

/** Stream one HealthData XML. No archive entry is extracted to the filesystem. */
export async function* appleHealthUploadStream(path,{zip=false}={}){
 let bytes=0;
 if(!zip){for await(const chunk of createReadStream(path)){bytes+=chunk.length;if(bytes>MAX_HEALTH_BYTES)throw fail('健康 XML 超过 2 GB 限制');yield chunk;}return;}
 await zipEntries(path);
 // A wildcard is intentional: Apple's localized ZIP names can contain legacy
 // filename bytes that cannot round-trip through UTF-8 argv. The listing above
 // requires exactly one non-CDA XML, and the XML parser rejects multiple roots.
 const child=spawn('/usr/bin/unzip',['-C','-p',path,'*.xml','-x','*export_cda.xml'],{stdio:['ignore','pipe','pipe']});
 let failed;child.on('error',error=>{failed=error;});child.stderr.resume();
 const ended=new Promise(resolve=>child.once('close',code=>resolve(code)));
 try{
  for await(const chunk of child.stdout){bytes+=chunk.length;if(bytes>MAX_HEALTH_BYTES)throw fail('ZIP 中的健康 XML 解压后超过 2 GB 限制');yield chunk;}
  const code=await ended;if(failed||code!==0)throw fail('健康 ZIP 解压校验失败，请重新导出或选择解压后的 XML');
 }finally{if(child.exitCode===null&&!child.killed)child.kill();await ended;}
}
