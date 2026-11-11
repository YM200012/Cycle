import test from 'node:test';
import assert from 'node:assert/strict';
import {healthChartGroups,wellnessTrendView} from '../src/wellness-trends.js';
const esc=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const num=(value,places=0)=>Number(value).toFixed(places);
function context(records){const calls=[];return {records,from:'2026-11-01',to:'2026-11-03',esc,num,chart:(series,options)=>{calls.push({series,options});return '<svg></svg>';},calls};}
test('health charts separate units and category states, preserve missing days and show aggregation meaning',()=>{
 const quantity={type:'HKQuantityTypeIdentifierCustom',label:'自定义指标',kind:'quantity',method:'mean',sampleCount:1,start:0,end:0,names:['Watch']},category={type:'HKCategoryTypeIdentifierCustom',label:'症状 · 轻度',kind:'category',method:'count',unit:'次',sampleCount:1,start:0,end:0,names:['Watch']};
 const ctx=context([{date:'2026-11-01',healthMetrics:[{...quantity,id:'custom:kg',unit:'kg',value:3},{...quantity,id:'custom:cm',unit:'cm',value:10},{...category,id:'symptom:mild',value:2}]},{date:'2026-11-03',healthMetrics:[{...quantity,id:'custom:kg',unit:'kg',value:5}]}]);
 const html=healthChartGroups(ctx);assert.equal(ctx.calls.length,3);assert.deepEqual(ctx.calls[0].series[0].values,[3,null,5]);assert.deepEqual(ctx.calls[1].series[0].values,[10,null,null]);assert.match(html,/每日均值/);assert.match(html,/每日事件次数/);assert.match(html,/症状 · 轻度/);assert.match(html,/期间合计/);assert.ok(!html.includes('<table'));assert.match(html,/data-health-chart-search/);
});
test('health graph groups exclude out-of-range channels and escape unknown labels',()=>{
 const ctx=context([{date:'2026-10-01',healthMetrics:[{id:'old',type:'old',label:'old',unit:'x',kind:'quantity',method:'sum',value:1}]},{date:'2026-11-02',healthMetrics:[{id:'new',type:'new',label:'<img src=x>',unit:'<x>',kind:'quantity',method:'sum',value:4}]}]);
 const html=healthChartGroups(ctx);assert.equal(ctx.calls.length,1);assert.ok(!html.includes('data-health-channel="old"'));assert.match(html,/&lt;img src=x&gt;/);assert.ok(!html.includes('<img src=x>'));
});
test('wellness and import previews remain charts only while legacy metrics still appear',()=>{
 const ctx=context([{date:'2026-11-01',weight:70,restHr:50}]);
 const preview=healthChartGroups({...ctx,includeLegacy:true});assert.match(preview,/体重/);assert.match(preview,/静息心率/);assert.ok(!preview.includes('<table'));
 const page=wellnessTrendView({...ctx,range:30,end:'2026-11-03'});assert.ok(!page.includes('<table'));assert.match(page,/已完成训练负荷/);
});
