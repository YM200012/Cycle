import test from 'node:test';
import assert from 'node:assert/strict';
import {planningOverview} from '../src/planning.mjs';

function target(id,date,extra={}) {
 return {id,date,name:'训练 '+id,type:'Ride',duration:60,load:50,planned:true,
  planOrigin:{planId:'plan',planName:'周期',batchId:'batch',entryId:id,startDate:'2026-11-01',plannedDate:date,targetDuration:60,targetLoad:50},...extra};
}
function actual(id,date,extra={}) {return {id,date,name:'实际 '+id,type:'Ride',duration:55,load:65,planned:false,...extra};}

test('adherence separates overdue, due today, future and completed targets at an explicit date',()=>{
 const activities=[target('overdue','2026-11-08'),target('today','2026-11-09'),target('future','2026-11-10'),target('done','2026-11-07',{completionId:'ride'}),actual('ride','2026-11-07')];
 const result=planningOverview(activities,'2026-11-09'),b=result.batches[0];
 assert.equal(result.asOf,'2026-11-09');assert.equal(b.dueTotal,3);assert.equal(b.dueCompleted,1);assert.equal(b.overdue,1);assert.equal(b.dueToday,1);assert.equal(b.upcoming,1);assert.equal(b.adherenceRate,1/3);
 assert.deepEqual(b.items.map(i=>[i.planned.id,i.status,i.timing]),[['done','completed','completed'],['overdue','pending','overdue'],['today','pending','due-today'],['future','pending','upcoming']]);
 assert.equal(b.total,4);assert.equal(b.completed,1);assert.equal(b.plannedDuration,240);assert.equal(b.plannedLoad,200);assert.equal(b.actualDuration,55);assert.equal(b.actualLoad,65);
});

test('adherence uses rescheduled date while preserving original targets and considers actual completion date',()=>{
 const moved=target('moved','2026-11-05');moved.date='2026-11-12';
 const activities=[moved,target('late','2026-11-07',{completionId:'late-actual'}),actual('late-actual','2026-11-10'),target('early','2026-11-15',{completionId:'early-actual'}),actual('early-actual','2026-11-08')];
 const before=structuredClone(activities),b=planningOverview(activities,'2026-11-09').batches[0];
 assert.equal(b.dueTotal,1);assert.equal(b.dueCompleted,0);assert.equal(b.adherenceRate,0);assert.equal(b.completed,2);assert.equal(b.upcoming,1);assert.equal(b.overdue,0);
 assert.equal(b.items.find(i=>i.planned.id==='late').timing,'completed');
 assert.equal(b.items.find(i=>i.planned.id==='moved').planned.planOrigin.plannedDate,'2026-11-05');
 assert.equal(b.actualLoad,130);assert.equal(b.actualDuration,110);assert.deepEqual(activities,before);
 const after=planningOverview(activities,'2026-11-15').batches[0];assert.equal(after.dueTotal,3);assert.equal(after.dueCompleted,2);assert.equal(after.overdue,1);assert.equal(after.adherenceRate,2/3);
});

test('manual completion counts only when both target and actual activity dates are due',()=>{
 const done=target('done','2026-11-08',{planned:false,duration:70,load:80});
 const b=planningOverview([done],'2026-11-09').batches[0];assert.equal(b.completed,1);assert.equal(b.dueTotal,1);assert.equal(b.dueCompleted,1);assert.equal(b.adherenceRate,1);assert.equal(b.actualDuration,70);assert.equal(b.plannedDuration,60);assert.equal(b.actualLoad,80);assert.equal(b.plannedLoad,50);
 const earlier=planningOverview([done],'2026-11-07').batches[0];assert.equal(earlier.completed,1);assert.equal(earlier.dueTotal,0);assert.equal(earlier.dueCompleted,0);assert.equal(earlier.adherenceRate,null);
});

test('empty denominator is null, default date is UTC, and invalid as-of dates are rejected',()=>{
 const empty=planningOverview([]);assert.equal(empty.asOf,new Date().toISOString().slice(0,10));assert.deepEqual(empty.batches,[]);
 const future=planningOverview([target('future','2026-12-01')],'2026-11-09').batches[0];assert.equal(future.adherenceRate,null);assert.equal(future.dueTotal,0);assert.equal(future.upcoming,1);
 for(const date of ['2026-02-30','2026-2-01','1899-12-31',null])assert.throws(()=>planningOverview([],date));
});
