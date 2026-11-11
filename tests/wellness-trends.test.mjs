import test from 'node:test';import assert from 'node:assert/strict';
import {wellnessTrends} from '../src/wellness-trends.mjs';
const range={from:'2026-11-01',to:'2026-11-09'};
test('wellness trends retain missing values and require three observed days per seven-day metric window',()=>{
 const records=[{date:'2026-11-01',hrv:0,sleep:0},{date:'2026-11-03',hrv:30,sleep:6},{date:'2026-11-04',hrv:60},{date:'2026-11-09',sleep:8}];
 const d=wellnessTrends(records,[],range);
 assert.equal(d.daily[1].hrv,null);assert.equal(d.daily[1].sleep,null);assert.equal(d.daily[2].mean7.hrv,null);assert.equal(d.daily[2].counts7.hrv,2);
 assert.equal(d.daily[3].mean7.hrv,30);assert.equal(d.daily[3].counts7.hrv,3);assert.equal(d.daily[3].mean7.sleep,null);assert.equal(d.daily[8].mean7.hrv,null);
 assert.deepEqual(d.summary.hrv,{latest:60,valueDate:'2026-11-04',mean:30,count:3});assert.equal(d.summary.weight.latest,null);
});
test('seven-day window includes six preceding days outside the displayed range and excludes the seventh',()=>{
 const records=[{date:'2026-10-25',weight:100},{date:'2026-10-26',weight:60},{date:'2026-10-29',weight:66},{date:'2026-11-01',weight:72}];
 const d=wellnessTrends(records,[],{from:'2026-11-01',to:'2026-11-01'});
 assert.equal(d.daily[0].mean7.weight,66);assert.equal(d.daily[0].counts7.weight,3);assert.equal(d.summary.weight.count,1);assert.equal(d.summary.weight.mean,72);
});
test('completed activities sum once per day while planned load is excluded and inputs remain unchanged',()=>{
 const records=[{date:'2026-11-01',weight:70},{date:'2026-11-01',weight:71},{date:'2026-11-02',restHr:'55'},{date:'2026-11-03',fatigue:0}];
 const activities=[{date:'2026-11-01',load:20,planned:false},{date:'2026-11-01',load:30},{date:'2026-11-02',load:200,planned:true},{date:'2026-11-03',load:0},{date:'2026-10-31',load:40}];
 const before=structuredClone({records,activities}),d=wellnessTrends(records,activities,range);
 assert.equal(d.daily[0].weight,71);assert.equal(d.daily[1].restHr,null);assert.equal(d.daily[2].fatigue,null);assert.equal(d.daily[0].load,50);assert.equal(d.daily[1].load,0);assert.deepEqual(d.training,{days:2,totalLoad:50});assert.deepEqual({records,activities},before);
});
test('wellness trend date range rejects normalized-invalid dates, reverse order, or more than 366 days',()=>{
 for(const options of [{from:'2026-02-30',to:'2026-03-01'},{from:'2026-1-01',to:'2026-02-01'},{from:'1899-12-31',to:'1900-01-01'},{from:'2026-11-10',to:'2026-11-09'},{from:'2025-01-01',to:'2026-01-02'}])assert.throws(()=>wellnessTrends([],[],options));
 assert.equal(wellnessTrends([],[],{from:'2024-01-01',to:'2024-12-31'}).daily.length,366);assert.equal(wellnessTrends([],[],range).summary.sleep.mean,null);
});
