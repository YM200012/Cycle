import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveFtp, normalizeAnalysisSettings } from '../src/settings.mjs';
import { defaults, powerAnalysis } from '../src/metrics.mjs';
import { startServer } from '../src/server.mjs';

test('historical FTP resolves effective-date boundaries, unsorted history, and current fallback', () => {
  const settings = { ftp: 300, ftpHistory: [{date:'2026-09-01',ftp:250},{date:'2026-01-01',ftp:200}] };
  assert.deepEqual(resolveFtp({date:'2025-12-31'},settings),{ftp:300,source:'current',effectiveDate:null});
  assert.deepEqual(resolveFtp({date:'2026-01-01'},settings),{ftp:200,source:'history',effectiveDate:'2026-01-01'});
  assert.equal(resolveFtp({date:'2026-08-31'},settings).ftp,200);
  assert.equal(resolveFtp({date:'2026-09-01'},settings).ftp,250);
  assert.equal(resolveFtp({date:'2027-01-01'},{...settings,ftp:350}).ftp,250);
  assert.equal(resolveFtp({},settings).ftp,300);
});

test('analysis settings validate history dates, duplicate dates, values, and integer durations', () => {
  assert.deepEqual(normalizeAnalysisSettings({}),{ftpHistory:[],effortThresholdPct:90,effortMinSeconds:60,effortRecoverySeconds:15});
  const normalized = normalizeAnalysisSettings({ftpHistory:[{date:'2026-09-01',ftp:250},{date:'2024-02-29',ftp:200}],effortThresholdPct:105.5,effortMinSeconds:30,effortRecoverySeconds:0});
  assert.equal(normalized.ftpHistory[0].date,'2024-02-29'); assert.equal(normalized.effortRecoverySeconds,0);
  for (const ftpHistory of [null,{},[{date:'2026-02-29',ftp:200}],[{date:'2026-02-30',ftp:200}],[{date:'2026-1-01',ftp:200}],[{date:'2026-01-01',ftp:0}],[{date:'2026-01-01'}],[{date:'2026-01-01',ftp:200},{date:'2026-01-01',ftp:210}]]) assert.throws(()=>normalizeAnalysisSettings({ftpHistory}));
  for (const patch of [{effortThresholdPct:29},{effortMinSeconds:4},{effortMinSeconds:10.5},{effortRecoverySeconds:-1},{effortRecoverySeconds:1.5},{effortRecoverySeconds:301}]) assert.throws(()=>normalizeAnalysisSettings(patch));
});

test('global power zones use each activity effective FTP without changing absolute best efforts', () => {
  const settings={...defaults,ftp:300,ftpHistory:[{date:'2026-01-01',ftp:200},{date:'2026-09-01',ftp:300}]};
  const rows=['2026-02-01','2026-10-01'].map((date,i)=>({id:String(i),date,streams:[{time:0,power:200},{time:30,power:200}]}));
  const result=powerAnalysis(rows,settings);
  assert.equal(result.zones[3].seconds,30);assert.equal(result.zones[1].seconds,30);
  assert.equal(result.curve.find(r=>r.seconds===30).watts,200);
});

test('history and thresholds persist atomically; load provenance and new/legacy backups remain compatible', async () => {
  const dir=await mkdtemp(join(tmpdir(),'cycle-settings-'));let server=await startServer({dataDir:dir});
  const api=async(path,method='GET',data)=>{const response=await fetch(server.url+'/api'+path,{method,headers:{'content-type':'application/json'},...(data===undefined?{}:{body:JSON.stringify(data)})});return {status:response.status,data:await response.json()};};
  try {
    const patch={ftp:300,ftpHistory:[{date:'2026-09-01',ftp:250},{date:'2026-01-01',ftp:200}],effortThresholdPct:105,effortMinSeconds:30,effortRecoverySeconds:0};
    const saved=await api('/settings','PUT',patch);assert.equal(saved.status,200);assert.equal(saved.data.ftpHistory[0].ftp,200);
    const streams=Array.from({length:3601},(_,time)=>({time,power:200}));
    const created=(await api('/activities','POST',{name:'Historical FTP',date:'2026-02-01',duration:60,load:7,streams})).data;
    const analysis=(await api(`/activities/${created.id}/analysis?mode=auto`)).data;
    assert.equal(analysis.summary.ftp,200);assert.equal(analysis.summary.ftpSource,'history');assert.equal(analysis.summary.ftpEffectiveDate,'2026-01-01');assert.equal(analysis.summary.tss,100);
    assert.equal(analysis.intervals.length,0);
    await api('/settings','PUT',{ftp:350});assert.equal((await api(`/activities/${created.id}`)).data.load,7);
    assert.equal((await api(`/activities/${created.id}/analysis`)).data.summary.tss,100);
    const applied=(await api(`/activities/${created.id}/apply-load`,'POST',{})).data;assert.equal(applied.load,100);assert.equal(applied.loadMeta.ftp,200);assert.equal(applied.loadMeta.ftpSource,'history');assert.equal(applied.loadMeta.ftpEffectiveDate,'2026-01-01');
    for (const invalid of [{ftpHistory:[{date:'2026-02-30',ftp:200}]},{ftpHistory:[{date:'2026-01-01',ftp:200},{date:'2026-01-01',ftp:250}]},{effortMinSeconds:0},{effortRecoverySeconds:-1}]) assert.equal((await api('/settings','PUT',invalid)).status,400);
    assert.equal((await api('/settings')).data.ftpHistory.length,2);
    const backup=(await api('/backup')).data;assert.equal((await api('/restore','POST',backup)).status,200);
    assert.deepEqual((await api(`/activities/${created.id}`)).data.loadMeta,applied.loadMeta);
    assert.deepEqual((await api('/settings')).data.ftpHistory,saved.data.ftpHistory);
    await server.close();server=await startServer({dataDir:dir});assert.equal((await api('/settings')).data.effortThresholdPct,105);
    const legacy={...backup,settings:{ftp:275},activities:[]};assert.equal((await api('/restore','POST',legacy)).status,200);
    const settings=(await api('/settings')).data;assert.deepEqual(settings.ftpHistory,[]);assert.equal(settings.effortMinSeconds,60);assert.equal(settings.effortRecoverySeconds,15);
  } finally {await server.close();await rm(dir,{recursive:true,force:true});}
});
