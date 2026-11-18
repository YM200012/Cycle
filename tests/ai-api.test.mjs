import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startServer} from '../src/server.mjs';

const credential='test-only-ai-api-credential';
const baseURL='https://ai-http-fixture.example/v1';
const json=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
const sampleRide=()=>({name:'PRIVATE_ACTIVITY_NAME',date:'2026-11-10',type:'Ride',duration:2,distance:1,
  notes:'PRIVATE_ACTIVITY_NOTES',power:150,hr:130,load:4,
  streams:Array.from({length:121},(_,time)=>({time,power:150,hr:130,cadence:85,speed:8,lat:31.987654321,lon:121.987654321}))});

async function fixture(run) {
  const dir=await mkdtemp(join(tmpdir(),'cycle-ai-http-'));
  const upstream=[];
  const aiFetcher=async(url,options)=>{
    upstream.push({url,options});
    if(url===baseURL+'/models')return json({data:[{id:'model-a'},{id:'model-b'}]});
    if(url.endsWith('/chat/completions'))return json({choices:[{message:{content:'本次训练：平均功率 150 W。'}}]});
    throw Error('Unexpected upstream destination: '+url);
  };
  let server;
  try {
    server=await startServer({dataDir:dir,aiFetcher});
    const api=async(path,method='GET',body)=>{
      const response=await fetch(server.url+'/api'+path,{method,...(body===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(body)})});
      return {status:response.status,data:await response.json()};
    };
    await run({api,upstream,restart:async()=>{await server.close();server=await startServer({dataDir:dir,aiFetcher});}});
  } finally {
    if(server)await server.close();
    await rm(dir,{recursive:true,force:true});
  }
}
const completions=upstream=>upstream.filter(request=>request.url.endsWith('/chat/completions'));
async function connect(api) {
  const configured=await api('/ai/config','PUT',{baseURL,apiKey:credential});
  assert.equal(configured.status,200);
  const listed=await api('/ai/models','POST',{});
  assert.equal(listed.status,200);
  assert.deepEqual(listed.data.models,[{id:'model-a'},{id:'model-b'}]);
  // Reading the model directory must leave the choice to the user.
  assert.equal((await api('/ai/config')).data.model,'');
  assert.equal((await api('/ai/config','PUT',{model:'model-a'})).status,200);
}

test('AI HTTP config exposes model choices, keeps credentials out of responses and training backups',async()=>fixture(async({api,upstream})=>{
  await connect(api);
  const configured=(await api('/ai/config')).data;
  assert.equal(configured.hasKey,true);
  assert.equal(configured.model,'model-a');
  assert.deepEqual(configured.models,[{id:'model-a'},{id:'model-b'}]);
  assert.ok(!JSON.stringify(configured).includes(credential));
  assert.equal(Object.hasOwn(configured,'apiKey'),false);
  const backup=(await api('/backup')).data;
  assert.ok(!JSON.stringify(backup).includes(credential));
  assert.ok(!JSON.stringify(backup).includes(baseURL));
  assert.equal(Object.hasOwn(backup,'ai'),false);
  assert.equal(Object.hasOwn(backup.settings,'apiKey'),false);
  assert.equal(upstream.length,1);
  assert.equal(upstream[0].url,baseURL+'/models');
  assert.equal(upstream[0].options.headers.Authorization,'Bearer '+credential);
  assert.equal(upstream[0].options.body,undefined);
  const removed=await api('/ai/config','DELETE');
  assert.equal(removed.status,200);
  assert.equal(removed.data.hasKey,false);
  assert.equal(removed.data.model,'');
  assert.deepEqual(removed.data.models,[]);
}));

test('activity conversation survives restart and editing, sends same-provider history, and can be cleared',async()=>fixture(async({api,upstream,restart})=>{
  await connect(api);
  const {id:activityId}=(await api('/activities','POST',sampleRide())).data;
  const path='/ai/context?activityId='+activityId;
  const preview=async()=>(await api(path)).data;
  const ask=(view,question)=>api('/ai/review','POST',{activityId,question,contextFingerprint:view.fingerprint,threadRevision:view.thread.revision});
  const first=await preview();
  assert.equal((await ask(first,'第一轮问题')).status,200);
  assert.equal((await ask(first,'从过期预览重复发送')).status,409);
  assert.equal((await api('/activities/'+activityId,'PUT',{notes:'更新备注'})).status,200);
  await restart();
  const second=await preview();
  assert.equal(second.thread.turns[0].question,'第一轮问题');
  assert.equal(second.thread.contextTurns,1);
  assert.equal((await ask(second,'再说明一下')).status,200);
  const messages=JSON.parse(completions(upstream).at(-1).options.body).messages;
  assert.deepEqual(messages.map(m=>m.role),['system','user','assistant','user']);
  assert.equal(messages[1].content,'第一轮问题');
  assert.equal(JSON.parse(messages[3].content).question,'再说明一下');
  await api('/ai/config','PUT',{baseURL:'https://other.example/v1',apiKey:credential,model:'model-a'});
  const other=await preview();
  assert.equal(other.thread.contextTurns,0);
  assert.equal(other.thread.turns.length,2);
  assert.equal((await ask(other,'新服务上的问题')).status,200);
  assert.equal(JSON.parse(completions(upstream).at(-1).options.body).messages.length,2);
  assert.ok(!JSON.stringify((await api('/backup')).data).includes('第一轮问题'));
  assert.equal((await api('/ai/thread?activityId='+activityId,'DELETE')).status,200);
  assert.deepEqual((await preview()).thread.turns,[]);
}));

test('activity preview and explicit AI generation send only numerical training facts',async()=>fixture(async({api,upstream})=>{
  await connect(api);
  await api('/settings','PUT',{name:'PRIVATE_PERSON_NAME',ftp:175});
  assert.equal((await api('/wellness','POST',{date:'2026-11-10',sleep:7.25,hrv:47.123456,notes:'PRIVATE_HEALTH_NOTES'})).status,200);
  const created=await api('/activities','POST',sampleRide());
  assert.equal(created.status,201);
  const activityId=created.data.id;
  const preview=await api('/ai/context?activityId='+encodeURIComponent(activityId));
  assert.equal(preview.status,200);
  assert.equal(preview.data.activityId,activityId);
  assert.equal(preview.data.model,'model-a');
  assert.equal(preview.data.baseURL,baseURL);
  assert.match(preview.data.fingerprint,/^[a-f0-9]{64}$/);
  assert.equal(preview.data.context.metrics.avgPower.value,150);
  assert.equal(preview.data.context.athlete.ftpWatts,175);
  assert.equal(completions(upstream).length,0);
  const forbidden=new Set(['name','date','notes','lat','lon','streams','wellness','healthMetrics','sleep','hrv','fitDevices','apiKey']);
  const checkKeys=value=>{
    if(!value||typeof value!=='object')return;
    for(const [key,item]of Object.entries(value)){assert.equal(forbidden.has(key),false,'private field in preview: '+key);checkKeys(item);}
  };
  checkKeys(preview.data.context);
  const previewJSON=JSON.stringify(preview.data.context);
  for(const marker of ['PRIVATE_',credential,'31.987654321','121.987654321','47.123456'])assert.ok(!previewJSON.includes(marker));
  assert.equal((await api('/ai/review','POST',{activityId})).status,409);
  assert.equal(completions(upstream).length,0);
  const result=await api('/ai/review','POST',{activityId,contextFingerprint:preview.data.fingerprint,question:'请分析本次训练的执行。',context:{notes:'PRIVATE_INJECTED_NOTES'},wellness:{hrv:47.123456}});
  assert.equal(result.status,200);
  assert.equal(result.data.model,'model-a');
  assert.equal(result.data.text,'本次训练：平均功率 150 W。');
  assert.equal(result.data.fingerprint,preview.data.fingerprint);
  assert.ok(!JSON.stringify(result.data).includes(credential));
  assert.equal(completions(upstream).length,1);
  const request=completions(upstream)[0],body=JSON.parse(request.options.body);
  assert.equal(request.options.headers.Authorization,'Bearer '+credential);
  assert.equal(body.model,'model-a');
  const input=JSON.parse(body.messages.find(message=>message.role==='user').content);
  assert.equal(input.question,'请分析本次训练的执行。');
  assert.deepEqual(input.activitySummary,preview.data.context);
  for(const marker of ['PRIVATE_',credential,'31.987654321','47.123456'])assert.ok(!request.options.body.includes(marker));
  assert.equal((await api('/settings')).data.ftp,175);
  const stored=(await api('/activities/'+activityId)).data;
  assert.equal(stored.notes,'PRIVATE_ACTIVITY_NOTES');
  assert.equal(stored.load,4);
}));

test('changed FTP, activity samples or selected model invalidate the preview before any upstream generation',async()=>fixture(async({api,upstream})=>{
  await connect(api);
  await api('/settings','PUT',{ftp:175});
  const activity=(await api('/activities','POST',sampleRide())).data,activityId=activity.id;
  const preview=async()=>(await api('/ai/context?activityId='+encodeURIComponent(activityId))).data;
  const review=async contextFingerprint=>api('/ai/review','POST',{activityId,contextFingerprint});
  let current=await preview();
  await api('/settings','PUT',{ftp:190});
  assert.equal((await review(current.fingerprint)).status,409);
  assert.equal(completions(upstream).length,0);
  let next=await preview();
  assert.notEqual(next.fingerprint,current.fingerprint);
  assert.equal(next.context.athlete.ftpWatts,190);
  current=next;
  assert.equal((await api('/activities/'+activityId,'PUT',{...activity,power:170,streams:activity.streams.map(row=>({...row,power:170}))})).status,200);
  assert.equal((await review(current.fingerprint)).status,409);
  assert.equal(completions(upstream).length,0);
  next=await preview();
  assert.notEqual(next.fingerprint,current.fingerprint);
  assert.equal(next.context.metrics.avgPower.value,170);
  current=next;
  assert.equal((await api('/ai/config','PUT',{model:'model-b'})).status,200);
  assert.equal((await review(current.fingerprint)).status,409);
  assert.equal(completions(upstream).length,0);
  next=await preview();
  assert.notEqual(next.fingerprint,current.fingerprint);
  assert.equal(next.model,'model-b');
  assert.equal((await review(next.fingerprint)).status,200);
  assert.equal(completions(upstream).length,1);
  assert.equal(JSON.parse(completions(upstream)[0].options.body).model,'model-b');
}));
