import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, stat, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createAIService, buildActivityContext, DEFAULT_AI_BASE_URL} from '../src/ai.mjs';
import {analyzeActivity} from '../src/analysis.mjs';

async function fixture(run, options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'cycle-ai-'));
  try { await run(createAIService({dataDir:dir, ...options}), dir); }
  finally { await rm(dir, {recursive:true, force:true}); }
}
const json = body => new Response(JSON.stringify(body), {headers:{'content-type':'application/json'}});
const key = 'test-credential-for-unit-test';

test('AI config keeps the credential in a private standalone file and never returns it', async () => {
  await fixture(async (service, dir) => {
    assert.deepEqual(await service.getStatus(), {baseURL:DEFAULT_AI_BASE_URL, model:'', hasKey:false, models:[], modelsFetchedAt:null});
    assert.deepEqual(await service.saveConfig({apiKey:key, model:'model-a'}), {baseURL:DEFAULT_AI_BASE_URL, model:'model-a', hasKey:true, models:[], modelsFetchedAt:null});
    assert.equal((await stat(path.join(dir, 'ai-config.json'))).mode & 0o777, 0o600);
    assert.equal(JSON.parse(await readFile(path.join(dir, 'ai-config.json'), 'utf8')).apiKey, key);
    await service.saveConfig({apiKey:'', model:'model-b'});
    assert.equal((await service.getStatus()).hasKey, true);
    const reopened = createAIService({dataDir:dir});
    assert.equal((await reopened.getStatus()).model, 'model-b');
    assert.ok(!JSON.stringify(await reopened.getStatus()).includes(key));
    await service.saveConfig({clearKey:true});
    assert.equal((await service.getStatus()).hasKey, false);
    assert.equal((await service.getStatus()).model, '');
    await service.clearConfig();
    assert.deepEqual(await service.getStatus(), {baseURL:DEFAULT_AI_BASE_URL, model:'', hasKey:false, models:[], modelsFetchedAt:null});
    await assert.rejects(readFile(path.join(dir, 'ai-config.json')), {code:'ENOENT'});
  });
});

test('AI settings reject embedded credentials, insecure remote URLs and invalid headers', async () => {
  await fixture(async service => {
    for (const baseURL of ['ftp://example.com','http://example.com/v1','https://user:pass@example.com/v1','https://example.com/v1?apiKey=secret','https://example.com/#x'])
      await assert.rejects(service.saveConfig({baseURL}), {status:400});
    for (const patch of [{apiKey:'line\r\nbreak'}, {model:'not a model'}, {apiKey:null}, {baseURL:null}]) await assert.rejects(service.saveConfig(patch), {status:400});
    assert.equal((await service.saveConfig({baseURL:'http://127.0.0.1:1234/v1/'})).baseURL, 'http://127.0.0.1:1234/v1');
  });
});

test('changing API endpoints never carries the previous credential to the new destination', async () => {
  await fixture(async (service, dir) => {
    await service.saveConfig({apiKey:key,model:'model-a'});
    await service.listModels();
    assert.equal((await service.getStatus()).models.length,1);
    const changed = await service.saveConfig({baseURL:'https://new-provider.example/v1',apiKey:''});
    assert.equal(changed.hasKey,false);
    assert.equal(changed.model,'');
    assert.deepEqual(changed.models,[]);
    assert.ok(!String(await readFile(path.join(dir,'ai-config.json'))).includes(key));
    await assert.rejects(service.listModels(),{status:400});
    await service.saveConfig({apiKey:'replacement',model:'model-a'});
    const updated = await service.saveConfig({baseURL:'https://another-provider.example/v1',apiKey:'new-credential',model:'model-b'});
    assert.equal(updated.hasKey,true);
    assert.equal(updated.model,'model-b');
    assert.equal(JSON.parse(await readFile(path.join(dir,'ai-config.json'))).apiKey,'new-credential');
  }, {fetchImpl:async () => json({data:[{id:'model-a'}]})});
});

test('model discovery authenticates, deduplicates IDs and leaves model choice to the user', async () => {
  let calls = 0;
  await fixture(async (service, dir) => {
    await service.saveConfig({apiKey:key});
    const listed = await service.listModels();
    assert.deepEqual(listed.models, [{id:'model-a'}, {id:'model-z'}]);
    assert.equal(typeof listed.fetchedAt, 'string');
    const config = await service.getStatus();
    assert.deepEqual(config.models, listed.models);
    assert.equal(config.modelsFetchedAt,listed.fetchedAt);
    assert.equal((await stat(path.join(dir,'ai-models.json'))).mode & 0o777, 0o600);
    assert.equal((await service.getStatus()).model, '');
    assert.equal(calls, 1);
    await assert.rejects(service.saveConfig({model:'gpt-image-1'}), {status:400});
    await service.clearConfig();
    await assert.rejects(readFile(path.join(dir,'ai-models.json')), {code:'ENOENT'});
  }, {fetchImpl:async (url, options) => {
    calls++;
    assert.equal(url, DEFAULT_AI_BASE_URL+'/models');
    assert.equal(options.headers.Authorization, 'Bearer '+key);
    assert.equal(options.redirect, 'error');
    return json({data:[{id:'model-z'}, {id:'model-a'}, {id:'model-z'}, {id:'gpt-image-1'}, {id:'text-embedding-3'}, {id:''}, {id:key}, {id:'bad\nmodel'}, {}]});
  }});
});

test('late model discovery cannot recreate a deleted connection cache', async () => {
  let release, started;
  const fetched = new Promise(resolve => {started = resolve;});
  await fixture(async (service, dir) => {
    await service.saveConfig({apiKey:key});
    const pending = service.listModels();
    await fetched;
    await service.clearConfig();
    release(json({data:[{id:'old-model'}]}));
    await assert.rejects(pending, {status:409});
    await assert.rejects(readFile(path.join(dir,'ai-models.json')), {code:'ENOENT'});
  }, {fetchImpl:async () => {started(); return new Promise(resolve => {release=resolve;});}});
});

test('activity context contains training facts and preserves nulls, excluding names, GPS and health', () => {
  const activity = {type:'Ride', name:'PRIVATE-ride-name', notes:'PRIVATE-notes', date:'2026-11-01', duration:60,
    distance:30, fitDevices:[{serialNumber:'PRIVATE-device'}], wellness:{sleep:'PRIVATE-health'},
    streams:[{time:0,power:175,hr:140,cadence:90,speed:8,lat:31.2,lon:121.4},{time:1,power:175,hr:140,cadence:90,speed:8,lat:31.3,lon:121.5}]};
  const context = buildActivityContext(activity, analyzeActivity(activity, {ftp:175}), {ftp:175, weight:70, maxHr:190, name:'PRIVATE-person'});
  const raw = JSON.stringify(context);
  assert.ok(!raw.includes('PRIVATE'));
  for (const field of ['lat','lon','streams','fitDevices','wellness','date','name']) assert.ok(!Object.hasOwn(context, field));
  assert.equal(context.metrics.normalizedPower.value, null);
  assert.equal(context.metrics.avgPower.value,175);
  assert.equal(context.metrics.avgCadence.value,90);
  assert.equal(context.athlete.ftpWatts,175);
  assert.deepEqual(context.bestEfforts, []);
  assert.equal(context.metrics.coverage.value,0);
  assert.equal(context.metrics.avgSpeed.unit, 'km/h');
});

test('summary-only FIT retains device NP, IF and TSS with device provenance and scope', async () => {
  const activity = {type:'Ride', duration:60, fitSummary:{normalizedPower:210, intensityFactor:.84, trainingStressScore:70, avgPower:195, avgHr:145}};
  const analysis = analyzeActivity(activity,{ftp:175});
  assert.equal(analysis.summary.normalizedPower,null);
  assert.equal(analysis.summary.intensityFactor,null);
  assert.equal(analysis.summary.tss,null);
  const context = buildActivityContext(activity,analysis,{ftp:175});
  assert.deepEqual(context.metrics.normalizedPower,{value:210,unit:'W',source:'device',scope:'设备记录'});
  assert.deepEqual(context.metrics.intensityFactor,{value:.84,unit:'ratio',source:'device',scope:'设备记录'});
  assert.deepEqual(context.metrics.tss,{value:70,unit:'TSS',source:'device',scope:'设备记录'});
  assert.equal(context.metrics.avgPower.value,195);
  assert.equal(context.metrics.avgHr.value,145);
  // The baseline is current/historical FTP, not reverse-inferred from device IF.
  assert.equal(context.athlete.ftpWatts,175);
  let submitted;
  await fixture(async service => {
    await service.saveConfig({apiKey:key,model:'text-model'});
    await service.review({context});
    const sent = JSON.parse(submitted.messages[1].content).activitySummary;
    assert.deepEqual(sent.metrics.tss,context.metrics.tss);
    assert.ok(submitted.messages[0].content.includes('设备 IF/TSS 可能使用不同 FTP'));
  }, {fetchImpl:async (_,options) => {submitted=JSON.parse(options.body);return json({choices:[{message:{content:'设备记录 TSS 为 70。'}}]});}});
});

test('partial-stream fallbacks keep observed scope and do not become whole-ride load', () => {
  const activity = {type:'Ride',duration:90,streams:[...Array.from({length:1801},(_,time)=>({time,power:200,hr:140})),...Array.from({length:1801},(_,i)=>({time:3600+i,power:200,hr:154}))]};
  const analysis = analyzeActivity(activity,{ftp:250}), context = buildActivityContext(activity,analysis,{ftp:250});
  assert.equal(analysis.summary.tss,null);
  assert.deepEqual(context.metrics.normalizedPower,{value:200,unit:'W',source:'calculated',scope:'仅有效记录'});
  assert.deepEqual(context.metrics.tss,{value:64,unit:'TSS',source:'calculated',scope:'仅有效记录'});
  assert.equal(context.metrics.decoupling.scope,'仅有效配对记录');
  const corrected = {...activity,streams:[{time:0,power:200},{time:20,power:200}],fitSummary:{normalizedPower:210,intensityFactor:.84,trainingStressScore:70},powerCorrections:[{time:0,power:100}]};
  const correctedContext = buildActivityContext(corrected,analyzeActivity(corrected,{ftp:250}),{ftp:250});
  assert.deepEqual(correctedContext.metrics.normalizedPower,{value:null,unit:'W',source:null,scope:null});
  assert.deepEqual(correctedContext.metrics.tss,{value:null,unit:'TSS',source:null,scope:null});
});

test('review sends selected model and whitelisted summary, with bounded output and credential scrubbing', async () => {
  let outbound;
  await fixture(async service => {
    await service.saveConfig({apiKey:key});
    await assert.rejects(service.review({context:{}}), {status:400});
    await service.saveConfig({model:'chosen-model'});
    const context = buildActivityContext({type:'Ride', duration:60}, {}, {ftp:175});
    await assert.rejects(service.review({context,expectedConfig:{baseURL:DEFAULT_AI_BASE_URL,model:'old-model'}}),{status:409});
    await assert.rejects(service.review({context,expectedConfig:{baseURL:'https://old-provider.example/v1',model:'chosen-model'}}),{status:409});
    context.rawPrivateData = 'PRIVATE-not-for-upstream';
    context.activity.name = 'PRIVATE-name';
    context.metrics.unknownHealth = {value:'PRIVATE-health'};
    const result = await service.review({context, question:'这次骑行的强度如何？', expectedConfig:{baseURL:DEFAULT_AI_BASE_URL,model:'chosen-model'}});
    assert.equal(result.model,'chosen-model');
    assert.ok(!result.text.includes(key));
    assert.ok(result.text.includes('密钥已隐藏'));
    assert.equal(outbound.model,'chosen-model');
    assert.equal(outbound.stream,false);
    assert.equal(outbound.max_tokens,2600);
    assert.equal(outbound.messages[0].role,'system');
    assert.ok(outbound.messages[0].content.includes('不从一次普通训练推断 FTP 下降'));
    const user = JSON.parse(outbound.messages[1].content);
    assert.equal(user.question,'这次骑行的强度如何？');
    assert.ok(!JSON.stringify(user).includes('PRIVATE'));
    assert.equal(user.activitySummary.metrics.tss.value,null);
    await assert.rejects(service.review({context,question:'a'.repeat(2001)}), {status:400});
  }, {fetchImpl:async (url, options) => {
    assert.equal(url,DEFAULT_AI_BASE_URL+'/chat/completions');
    outbound = JSON.parse(options.body);
    return json({choices:[{message:{content:`训练表现说明 ${key}`}}]});
  }});
});

test('upstream failures are mapped without leaking request credentials or upstream details', async () => {
  for (const response of [new Response('private-upstream '+key, {status:401}), new Response('private-upstream '+key, {status:429}), new Response('private-upstream '+key, {status:500}), json({data:null}), new Response('not-json '+key)]) {
    await fixture(async service => {
      await service.saveConfig({apiKey:key});
      await assert.rejects(service.listModels(), error => error.status === 502 && !error.message.includes(key) && !error.message.includes('private-upstream'));
    }, {fetchImpl:async () => response});
  }
});

test('upstream timeouts abort requests, and large responses stop reading at the size limit', async () => {
  let signal;
  await fixture(async service => {
    await service.saveConfig({apiKey:key});
    await assert.rejects(service.listModels(), {status:504});
    assert.equal(signal.aborted,true);
  }, {timeoutMs:15, fetchImpl:async (_, options) => {signal=options.signal; return new Promise(() => {});}});
  await fixture(async service => {
    await service.saveConfig({apiKey:key});
    await assert.rejects(service.listModels(), error => error.status === 502 && error.message.includes('过大'));
  }, {fetchImpl:async () => new Response('x'.repeat(1024*1024+1))});
});

test('empty model completions produce an actionable response error', async () => {
  await fixture(async service => {
    await service.saveConfig({apiKey:key,model:'m'});
    await assert.rejects(service.review({context:{}}), error => error.status === 502 && error.message.includes('没有返回'));
  }, {fetchImpl:async () => json({choices:[{message:{content:null}}]})});
});
