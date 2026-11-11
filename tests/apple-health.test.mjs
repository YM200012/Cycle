import test from 'node:test';
import assert from 'node:assert/strict';
import {parseAppleHealthXml,parseAppleHealthStream,inspectAppleHealthXml,inspectAppleHealthStream,APPLE_HEALTH_TYPES} from '../src/apple-health.mjs';
const types={weight:'HKQuantityTypeIdentifierBodyMass',restHr:'HKQuantityTypeIdentifierRestingHeartRate',hrv:'HKQuantityTypeIdentifierHeartRateVariabilitySDNN',sleep:'HKCategoryTypeIdentifierSleepAnalysis'};
const rec=(key,value,unit,extra={})=>'<Record '+Object.entries({type:types[key]||key,sourceName:'Apple Watch',startDate:'2026-11-09 08:00:00 +0800',endDate:'2026-11-09 08:00:00 +0800',unit,value,...extra}).filter(([,v])=>v!==undefined).map(([k,v])=>`${k}="${v}"`).join(' ')+'/>';
const xml=body=>'<?xml version="1.0" encoding="UTF-8"?><HealthData locale="zh_CN">'+body+'</HealthData>';
const sleep=(startDate,endDate,value='HKCategoryValueSleepAnalysisAsleepCore',sourceName='Apple Watch')=>rec('sleep',value,undefined,{startDate,endDate,sourceName});
test('Apple Health whitelist aggregates last weight, mean resting HR, median SDNN with units and provenance',async()=>{
 const result=await parseAppleHealthXml(xml(rec('weight','154.323583529','lb')+rec('weight','71','kg',{endDate:'2026-11-09 12:00:00 +0800'})+rec('restHr','50','count/min')+rec('restHr','60','count/min',{startDate:'2026-11-09 09:00:00 +0800',endDate:'2026-11-09 09:00:00 +0800'})+rec('hrv','.040','s')+rec('hrv','60','ms',{endDate:'2026-11-09 10:00:00 +0800'})+rec('hrv','100','ms',{endDate:'2026-11-09 11:00:00 +0800'})));
 assert.equal(result.records.length,1);const r=result.records[0];assert.equal(r.date,'2026-11-09');assert.equal(r.weight,71);assert.equal(r.restHr,55);assert.equal(r.hrv,60);assert.equal(r.sources.hrv.kind,'heartRateVariabilitySDNN');assert.equal(r.sources.hrv.method,'median');assert.deepEqual(result.sources,['Apple Watch']);assert.equal(result.summary.acceptedRecords,7);
 const pounds=await parseAppleHealthXml(xml(rec('weight','154.323583529','lb')));assert.equal(pounds.records[0].weight,70);
});
test('sleep stage/summary overlap and duplicate providers do not double-count; night belongs to wake day',async()=>{
 const body=sleep('2026-11-08 23:00:00 +0800','2026-11-09 07:00:00 +0800','HKCategoryValueSleepAnalysisAsleepUnspecified','Phone')+sleep('2026-11-08 23:00:00 +0800','2026-11-08 23:30:00 +0800')+sleep('2026-11-09 00:00:00 +0800','2026-11-09 01:00:00 +0800','HKCategoryValueSleepAnalysisAsleepDeep')+sleep('2026-11-09 01:00:00 +0800','2026-11-09 02:00:00 +0800','HKCategoryValueSleepAnalysisAsleepREM')+sleep('2026-11-08 22:00:00 +0800','2026-11-09 08:00:00 +0800','HKCategoryValueSleepAnalysisInBed')+sleep('2026-11-09 01:00:00 +0800','2026-11-09 01:30:00 +0800','HKCategoryValueSleepAnalysisAwake')+sleep('2026-11-08 23:00:00 +0800','2026-11-08 23:30:00 +0800','HKCategoryValueSleepAnalysisAsleepCore','Other Watch');
 const result=await parseAppleHealthXml(xml(body));assert.equal(result.records.length,1);assert.equal(result.records[0].date,'2026-11-09');assert.equal(result.records[0].sleep,8);assert.equal(result.summary.duplicateRecords,1);assert.deepEqual(result.records[0].sources.sleep.names,['Apple Watch','Other Watch','Phone']);
 const segmented=await parseAppleHealthXml(xml(sleep('2026-11-08 23:00:00 +0800','2026-11-08 23:30:00 +0800')+sleep('2026-11-09 00:00:00 +0800','2026-11-09 01:00:00 +0800')));assert.equal(segmented.records.length,1);assert.equal(segmented.records[0].sleep,1.5);
});
test('sleep splits at explicit-offset local noon and quantities use XML local date, not server timezone',async()=>{
 const result=await parseAppleHealthXml(xml(sleep('2026-11-09 11:00:00 -0500','2026-11-09 13:00:00 -0500')+rec('weight','70','kg',{startDate:'2026-11-09 23:30:00 -0500',endDate:'2026-11-09 23:30:00 -0500'})));
 assert.deepEqual(result.records.map(r=>[r.date,r.sleep]),[['2026-11-09',1],['2026-11-10',1]]);assert.equal(result.records[0].weight,70);
 const filtered=await parseAppleHealthXml(xml(sleep('2026-11-08 23:00:00 +0800','2026-11-09 07:00:00 +0800')+rec('weight','70','kg',{startDate:'2026-11-08 23:00:00 +0800',endDate:'2026-11-08 23:00:00 +0800'})),{from:'2026-11-09',to:'2026-11-09'});assert.equal(filtered.records.length,1);assert.equal(filtered.records[0].sleep,8);assert.equal(filtered.records[0].weight,undefined);
});
test('stream accepts Apple internal DTD and split UTF-8, skips workouts and ordinary exercise heart rate',async()=>{
 const text='<?xml version="1.0"?><!DOCTYPE HealthData [\n<!ELEMENT HealthData (Record*,Workout*)>\n<!ELEMENT Record EMPTY>\n<!ATTLIST Record type CDATA #REQUIRED>\n]>'+xml(rec('weight','70','kg',{sourceName:'设备 &amp; &#x8868; &quot;甲&quot;'})+'<Workout workoutActivityType="HKWorkoutActivityTypeCycling">'+rec('weight','100','kg')+'</Workout>'+rec('HKQuantityTypeIdentifierHeartRate','180','count/min')+rec('HKQuantityTypeIdentifierActiveEnergyBurned','100','kcal')).replace(/^<\?xml[^>]*>/,'');
 const bytes=new TextEncoder().encode(text);async function* chunks(){for(let i=0;i<bytes.length;i+=7)yield bytes.subarray(i,i+7);}const result=await parseAppleHealthStream(chunks());assert.equal(result.records.length,1);assert.equal(result.records[0].weight,70);assert.equal(result.summary.workoutsIgnored,1);assert.equal(result.summary.totalRecords,4);assert.equal(result.summary.ignoredRecords,3);assert.deepEqual(result.sources,['设备 & 表 "甲"']);
});
test('equivalent samples deduplicate across units/providers while keeping source names',async()=>{
 const result=await parseAppleHealthXml(xml(rec('hrv','50','ms')+rec('hrv','.050','s',{sourceName:'Other'})));assert.equal(result.summary.acceptedRecords,1);assert.equal(result.summary.duplicateRecords,1);assert.equal(result.records[0].hrv,50);assert.deepEqual(result.records[0].sources.hrv.names,['Apple Watch','Other']);
});
test('duplicate instants with different offset labels retain the original day without empty phantom records',async()=>{
 const result=await parseAppleHealthXml(xml(rec('weight','70','kg',{startDate:'2026-11-09 00:30:00 +0800',endDate:'2026-11-09 00:30:00 +0800'})+rec('weight','70','kg',{sourceName:'Synced copy',startDate:'2026-11-08 16:30:00 Z',endDate:'2026-11-08 16:30:00 Z'})));
 assert.equal(result.summary.duplicateRecords,1);assert.equal(result.records.length,1);assert.equal(result.records[0].date,'2026-11-09');assert.equal(result.records[0].weight,70);assert.deepEqual(result.records[0].sources.weight.names,['Apple Watch','Synced copy']);
});
test('malformed selected dates, units, values and XML entities reject the full preview',async()=>{
 for(const body of [rec('weight','NaN','kg'),rec('weight','70','stones'),rec('weight','1','kg'),rec('hrv','Infinity','ms'),rec('hrv','50','min'),rec('restHr','20','Hz'),rec('weight','70','kg',{startDate:'2026-02-30 00:00:00 +0800'}),rec('weight','70','kg',{endDate:'2026-11-09'}),rec('weight','70','kg',{endDate:'2026-11-08 00:00:00 +0800'}),rec('weight','70','kg',{sourceName:'Bad &name;'}),rec('weight','70','kg',{sourceName:'Bad & raw'}),rec('weight','70','kg',{sourceName:'Bad &#0;'}),'<Record type="HKQuantityTypeIdentifierBodyMass" type="x"/>'])await assert.rejects(parseAppleHealthXml(xml(rec('weight','71','kg')+body)),{status:400});
 for(const text of ['<HealthData>'+rec('weight','70','kg'),xml('')+'<HealthData/>','<Root>'+rec('weight','70','kg')+'</Root>','<HealthData><Other>'+rec('weight','70','kg')+'</Other></HealthData>','<!DOCTYPE HealthData [<!ENTITY leak SYSTEM "file:///etc/passwd">]>'+xml(''),'<!DOCTYPE HealthData SYSTEM "https://example.com/a.dtd">'+xml('')])await assert.rejects(parseAppleHealthXml(text),{status:400});
});
test('defensive sample/date limits reject clearly; out-of-range quantities are not retained',async()=>{
 await assert.rejects(parseAppleHealthXml(xml(rec('weight','70','kg')+rec('hrv','50','ms')),{maxSamples:1}),{status:400});await assert.rejects(parseAppleHealthXml(xml(''),{from:'2026-02-30',to:'2026-11-10'}),{status:400});await assert.rejects(parseAppleHealthXml(xml(''),{from:'2000-01-01',to:'2026-11-10'}),{status:400});
 const result=await parseAppleHealthXml(xml(rec('weight','3','kg',{startDate:'2000-01-01 00:00:00 +0800',endDate:'2000-01-01 00:00:00 +0800'})+rec('weight','70','kg')),{from:'2026-11-09',to:'2026-11-10'});assert.equal(result.records.length,1);assert.equal(result.summary.acceptedRecords,1);
});
test('inventory discovers all health types while excluding workouts',async()=>{
 const body=rec('weight','70','kg')+rec('weight','71','lb',{endDate:'2026-11-10 08:00:00 +0800'})+rec('HKQuantityTypeIdentifierStepCount','100','count')+rec('HKQuantityTypeIdentifierHeartRate','160','count/min')+rec('CustomMetric','4','custom')+'<Workout>'+rec('hrv','50','ms')+'</Workout>';
 const result=await inspectAppleHealthXml(xml(body));
 assert.equal(result.typeCount,4);assert.equal(result.supportedTypeCount,4);assert.equal(result.totalRecords,6);assert.equal(result.healthRecords,5);assert.equal(result.workoutsIgnored,1);assert.equal(result.from,'2026-11-09');assert.equal(result.to,'2026-11-10');
 const weight=result.types.find(t=>t.key==='weight');assert.equal(weight.count,2);assert.deepEqual(weight.units,['kg','lb']);assert.equal(weight.label,'体重');assert.equal(weight.supported,true);
 assert.equal(result.types.find(t=>t.id==='HKQuantityTypeIdentifierStepCount').label,'步数');assert.equal(result.types.find(t=>t.id==='CustomMetric').key,'CustomMetric');assert.equal(result.types.find(t=>t.id==='CustomMetric').supported,true);assert.equal(result.types.some(t=>t.key==='hrv'),false);
 assert.equal(APPLE_HEALTH_TYPES.length,4);assert.equal(Object.isFrozen(APPLE_HEALTH_TYPES[0]),true);
});
test('inventory streams UTF-8, tolerates invalid sample dates and applies sleep day boundaries',async()=>{
 const text='<!DOCTYPE HealthData [<!ELEMENT HealthData ANY>]>'+xml(rec('weight','not-a-number','kg',{sourceName:'中文设备',startDate:'invalid',endDate:'invalid'})+sleep('2026-11-09 13:00:00 +0800','2026-11-09 14:00:00 +0800'));
 const bytes=new TextEncoder().encode(text);async function* chunks(){for(let i=0;i<bytes.length;i+=3)yield bytes.subarray(i,i+3);}
 const result=await inspectAppleHealthStream(chunks());const weight=result.types.find(t=>t.key==='weight');assert.equal(weight.invalidDates,1);assert.equal(weight.from,null);assert.equal(weight.to,null);assert.equal(result.from,'2026-11-10');assert.equal(result.to,'2026-11-10');
 await assert.rejects(parseAppleHealthXml(text,{types:['weight']}),{status:400});
});
test('selection accepts canonical IDs and keys, skips unselected malformed data, and retains date limits',async()=>{
 const text=xml(rec('weight','broken','invalid',{startDate:'invalid'})+rec('hrv','50','ms')+rec('hrv','70','ms',{startDate:'2026-11-10 08:00:00 +0800',endDate:'2026-11-10 08:00:00 +0800'})+rec('restHr','55','count/min'));
 const result=await parseAppleHealthXml(text,{types:['hrv',types.restHr],from:'2026-11-09',to:'2026-11-09'});
 assert.equal(result.records.length,1);assert.equal(result.records[0].hrv,50);assert.equal(result.records[0].restHr,55);assert.equal(result.records[0].weight,undefined);assert.deepEqual(result.summary.selectedTypes,[types.hrv,types.restHr]);
 assert.deepEqual(await parseAppleHealthXml(text,{types:['hrv',types.restHr],from:'2026-11-09',to:'2026-11-09'}),result);
 for(const selection of [[],[null],['__proto__'],'weight',null])await assert.rejects(parseAppleHealthXml(text,{types:selection}),{status:400});
});
test('inventory rejects unsafe and truncated XML even when samples are unsupported',async()=>{
 for(const text of ['<HealthData>'+rec('Custom','1','unit'),'<Root/>','<!DOCTYPE HealthData SYSTEM "https://example.com/test.dtd"><HealthData/>','<!DOCTYPE HealthData [<!ENTITY x "unsafe">]><HealthData/>'])await assert.rejects(inspectAppleHealthXml(text),{status:400});
});
test('daily provenance tracks unique sample coverage for monthly refresh decisions',async()=>{
 const sample=rec('hrv','50','ms');const result=await parseAppleHealthXml(xml(sample+sample+rec('hrv','60','ms',{startDate:'2026-11-09 10:00:00 +0800',endDate:'2026-11-09 10:00:00 +0800'})+sleep('2026-11-08 23:00:00 +0800','2026-11-09 07:00:00 +0800')));
 const hrv=result.records[0].sources.hrv;assert.equal(hrv.sampleCount,2);assert.equal(hrv.start,Date.parse('2026-11-09T08:00:00+08:00'));assert.equal(hrv.end,Date.parse('2026-11-09T10:00:00+08:00'));
 const sleepCoverage=result.records[0].sources.sleep;assert.equal(sleepCoverage.sampleCount,1);assert.equal(sleepCoverage.start,Date.parse('2026-11-08T23:00:00+08:00'));assert.equal(sleepCoverage.end,Date.parse('2026-11-09T07:00:00+08:00'));
 const split=await parseAppleHealthXml(xml(sleep('2026-11-09 11:00:00 +0800','2026-11-09 13:00:00 +0800')));assert.equal(split.records[0].sources.sleep.end,Date.parse('2026-11-09T12:00:00+08:00'));assert.equal(split.records[1].sources.sleep.start,Date.parse('2026-11-09T12:00:00+08:00'));
});
test('all Record types can be selected; cumulative daily source total is not inflated by overlapping providers',async()=>{
 const step='HKQuantityTypeIdentifierStepCount',heart='HKQuantityTypeIdentifierHeartRate';const text=xml(rec(step,'100','count',{sourceName:'Phone',startDate:'2026-11-09 08:00:00 +0800',endDate:'2026-11-09 08:10:00 +0800'})+rec(step,'100','count',{sourceName:'Watch',startDate:'2026-11-09 08:00:00 +0800',endDate:'2026-11-09 08:10:00 +0800'})+rec(step,'120','count',{sourceName:'Watch',startDate:'2026-11-09 08:10:00 +0800',endDate:'2026-11-09 08:20:00 +0800'})+rec(heart,'60','bpm')+rec(heart,'90','count/min',{endDate:'2026-11-09 09:00:00 +0800'})+rec('CustomMetric','8','custom'));
 const inventory=await inspectAppleHealthXml(text);assert.equal(inventory.supportedTypeCount,3);const result=await parseAppleHealthXml(text,{types:inventory.types.map(t=>t.key)}),channels=result.records[0].healthMetrics;
 const steps=channels.find(c=>c.type===step);assert.equal(steps.method,'sum');assert.equal(steps.value,220);assert.equal(steps.selectedSource,'Watch');assert.equal(steps.sourcePolicy,'most-covered-source');assert.equal(steps.sampleCount,2);assert.deepEqual(steps.names,['Phone','Watch']);
 const hr=channels.find(c=>c.type===heart);assert.equal(hr.value,75);assert.equal(hr.min,60);assert.equal(hr.max,90);assert.equal(hr.unit,'bpm');assert.equal(channels.find(c=>c.type==='CustomMetric').value,8);
});
test('generic units normalize only known conversions and keep incompatible units in separate channels',async()=>{
 const dist='HKQuantityTypeIdentifierDistanceCycling',unknown='CustomMetric',oxygen='HKQuantityTypeIdentifierOxygenSaturation';
 const result=await parseAppleHealthXml(xml(rec(dist,'1','km')+rec(dist,'1000','m',{sourceName:'Other'})+rec(unknown,'2','a')+rec(unknown,'3','b')+rec(oxygen,'.97','%')),{types:[dist,unknown,oxygen]});const channels=result.records[0].healthMetrics;
 assert.equal(channels.filter(c=>c.type===dist).length,1);assert.equal(channels.find(c=>c.type===dist).value,1000);assert.equal(channels.find(c=>c.type===dist).unit,'m');assert.equal(channels.filter(c=>c.type===unknown).length,2);assert.equal(channels.find(c=>c.type===oxygen).value,97);
});
test('numeric categories stay category states, category durations union across devices and split at midnight',async()=>{
 const mindful='HKCategoryTypeIdentifierMindfulSession',symptom='HKCategoryTypeIdentifierFatigue';const text=xml(rec(mindful,'HKCategoryValueNotApplicable',undefined,{startDate:'2026-11-08 23:30:00 +0800',endDate:'2026-11-09 00:30:00 +0800'})+rec(mindful,'HKCategoryValueNotApplicable',undefined,{sourceName:'Other',startDate:'2026-11-09 00:00:00 +0800',endDate:'2026-11-09 00:30:00 +0800'})+rec(symptom,'3',undefined));
 const result=await parseAppleHealthXml(text,{types:[mindful,symptom]});assert.equal(result.records.length,2);const one=result.records[0].healthMetrics[0],two=result.records[1].healthMetrics;
 assert.equal(one.unit,'h');assert.equal(one.value,.5);assert.equal(two.find(c=>c.type===mindful).value,.5);const fatigue=two.find(c=>c.type===symptom);assert.equal(fatigue.kind,'category');assert.equal(fatigue.method,'count');assert.equal(fatigue.value,1);assert.match(fatigue.label,/中度/);
});
test('explicit sleep selection retains awake/in-bed and stage charts without double-counting total asleep',async()=>{
 const result=await parseAppleHealthXml(xml(sleep('2026-11-08 22:00:00 +0800','2026-11-09 08:00:00 +0800','HKCategoryValueSleepAnalysisInBed')+sleep('2026-11-08 23:00:00 +0800','2026-11-09 07:00:00 +0800','HKCategoryValueSleepAnalysisAsleepUnspecified')+sleep('2026-11-09 01:00:00 +0800','2026-11-09 02:00:00 +0800','HKCategoryValueSleepAnalysisAsleepDeep')+sleep('2026-11-09 02:00:00 +0800','2026-11-09 02:30:00 +0800','HKCategoryValueSleepAnalysisAwake')),{types:['sleep']});const row=result.records[0];assert.equal(row.sleep,8);assert.equal(row.healthMetrics.length,4);assert.equal(row.healthMetrics.find(c=>c.state==='HKCategoryValueSleepAnalysisInBed').value,10);assert.equal(row.healthMetrics.find(c=>c.state==='HKCategoryValueSleepAnalysisAwake').value,.5);assert.equal(row.healthMetrics.find(c=>c.state==='HKCategoryValueSleepAnalysisAsleepDeep').value,1);
});
test('unknown text states, zero values, source-independent duplicate identity and unsafe selections are handled',async()=>{
 const text=xml(rec('NewTextMetric','stateA',undefined)+rec('NewQuantityMetric','0','unit')+rec('NewQuantityMetric','0','unit',{sourceName:'Other'}));const r=await parseAppleHealthXml(text,{types:['NewTextMetric','NewQuantityMetric']});assert.equal(r.records[0].healthMetrics.find(c=>c.type==='NewTextMetric').value,1);assert.equal(r.records[0].healthMetrics.find(c=>c.type==='NewQuantityMetric').value,0);assert.equal(r.summary.duplicateRecords,1);await assert.rejects(parseAppleHealthXml(xml(rec('HKQuantityTypeIdentifierHeartRate','NaN','bpm')),{types:['HKQuantityTypeIdentifierHeartRate']}),{status:400});
});
test('unknown category states matching prototype names remain literal state strings',async()=>{
 const result=await parseAppleHealthXml(xml(rec('HKCategoryTypeIdentifierAppleStandHour','toString',undefined)+rec('HKCategoryTypeIdentifierAppleStandHour','__proto__',undefined)),{types:['HKCategoryTypeIdentifierAppleStandHour']});assert.deepEqual(result.records[0].healthMetrics.map(c=>c.state).sort(),['__proto__','toString']);
});
