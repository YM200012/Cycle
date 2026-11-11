import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {appleHealthUploadStream} from '../src/apple-health-upload.mjs';
async function read(path,options){const chunks=[];for await(const chunk of appleHealthUploadStream(path,options))chunks.push(chunk);return Buffer.concat(chunks).toString();}
test('health upload streams raw XML or one localized XML inside ZIP, excluding CDA and route files',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'cycle-health-zip-'));
 try{
  const xml='<HealthData></HealthData>';
  await writeFile(join(dir,'导出.xml'),xml);await writeFile(join(dir,'export_cda.xml'),'<ClinicalDocument/>');await writeFile(join(dir,'route.gpx'),'<gpx/>');
  execFileSync('/usr/bin/zip',['-q',join(dir,'health.zip'),'导出.xml','export_cda.xml','route.gpx'],{cwd:dir});
  assert.equal(await read(join(dir,'导出.xml')),xml);assert.equal(await read(join(dir,'health.zip'),{zip:true}),xml);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('health upload rejects ambiguous, CDA-only and corrupt ZIPs before parsing values',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'cycle-health-zip-'));
 try{
  for(const name of ['a.xml','b.xml','export_cda.xml'])await writeFile(join(dir,name),'<HealthData/>');
  execFileSync('/usr/bin/zip',['-q',join(dir,'ambiguous.zip'),'a.xml','b.xml'],{cwd:dir});
  execFileSync('/usr/bin/zip',['-q',join(dir,'cda.zip'),'export_cda.xml'],{cwd:dir});
  await writeFile(join(dir,'bad.zip'),'not zip');
  await assert.rejects(read(join(dir,'ambiguous.zip'),{zip:true}),/多个健康 XML/);
  await assert.rejects(read(join(dir,'cda.zip'),{zip:true}),/没有可读取/);
  await assert.rejects(read(join(dir,'bad.zip'),{zip:true}),/无法读取/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
