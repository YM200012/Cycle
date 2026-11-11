import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
test('browser entry and interactive modules parse as ES modules',()=>{
 for(const name of ['app.js','apple-health-tools.js','weather-view.js','weather.mjs','performance-estimates.mjs','activity-tools.js','chart-zoom.js','chart-series.mjs','elevation.mjs','route-map.js']){
  const r=spawnSync(process.execPath,['--check','--input-type=module'],{input:readFileSync(new URL('../src/'+name,import.meta.url)),encoding:'utf8'});assert.equal(r.status,0,name+'\n'+r.stderr);
 }
});
