import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EscapeStore, newSession } from '../src/escape-state.js';
import { EscapeEngine, appraisalSchema, legalActions, type Appraisal, type EscapeBackend } from '../src/escape-engine.js';
import type { EscapeAction } from '../src/escape-scenario.js';

const neutral=()=>appraisalSchema.parse({intent:'talk',topic:'none',cooperation:0,contradiction:0,plan:0,coverStory:0,danger:0,calming:0});
function harness(store=new EscapeStore()) {
  let now=1_800_000_000_000,serial=0;let appraisal=neutral();let action:EscapeAction='stab';
  const backend:EscapeBackend={assess:async()=>({appraisal,signals:{spam:0,addressed:1,opportunity:1,answered:0,interest:0.5,memory:0,selfFact:0,valence:0.2,arousal:0.8,dominance:0.6,reaction:'disapprove',memoryRelevance:{}}}),
    choose:async()=>action,write:async()=>({speech:'Stay with me.'})};
  store.put(newSession('t','g','p','u',now));
  const engine=new EscapeEngine(store,backend,()=>true,()=>now,()=>undefined);
  const play=(changes:Partial<Appraisal>={},choice:EscapeAction='stab')=>{now+=60_001;appraisal={...neutral(),...changes};action=choice;return engine.turn('t','u',`m${++serial}`,'Synthetic combat turn');};
  return {store,engine,play};
}

test('at breaking point Eddie can draw and stab without waiting for two warnings',async()=>{
  const h=harness();const s=h.store.get('t')!;s.anger=1;h.store.put(s);
  assert.ok(legalActions(s,neutral()).includes('stab'));assert.equal(s.escalation,0);
  const hit=await h.play();assert.equal(hit.physical.health,2);assert.equal(hit.physical.weapon,'raised');
  assert.equal(hit.ending,null);assert.match(hit.lastNarration,/draws her knife and lunges/);assert.match(hit.lastNarration,/stabs you/);
});

test('three resolved stabs kill, and an ended player cannot be attacked again',async()=>{
  const h=harness();const s=h.store.get('t')!;s.anger=1;h.store.put(s);
  await h.play();await h.play();const dead=await h.play();
  assert.equal(dead.physical.health,0);assert.equal(dead.ending,'dead');assert.match(dead.lastNarration,/stabs you again/);
  await assert.rejects(h.play(),/ended/);assert.equal(h.store.get('t')?.physical.health,0);
});

test('genuine calming lowers anger and permits backing down without healing damage',async()=>{
  const h=harness();const s=h.store.get('t')!;s.anger=1;s.physical.weapon='raised';s.physical.health=2;h.store.put(s);
  const calm=await h.play({calming:1,social:'reassure'},'back_down');
  assert.ok(calm.anger<0.75);assert.equal(calm.physical.weapon,'lowered');assert.equal(calm.physical.health,2);
});

test('a surviving player can get out wounded through an open door during an attack',async()=>{
  const h=harness();const s=h.store.get('t')!;s.anger=1;s.physical.weapon='raised';s.physical.health=2;s.physical.door='open';s.physical.blocking=true;h.store.put(s);
  const out=await h.play({attempts:['exit']});
  assert.equal(out.physical.health,1);assert.equal(out.physical.playerLocation,'outside');assert.equal(out.ending,'alone');
  assert.match(out.lastNarration,/Wounded/);assert.equal(out.physical.door,'open');
});

test('being stabbed does not open a locked door or give the player a key',async()=>{
  const h=harness();const s=h.store.get('t')!;s.anger=1;h.store.put(s);
  const hit=await h.play({attempts:['exit']});
  assert.equal(hit.physical.health,2);assert.equal(hit.physical.door,'locked');assert.equal(hit.physical.key,'held');assert.equal(hit.ending,null);
});

test('denied recognition and a swear-word compliment do not build attack anger',async()=>{
  const h=harness();
  const stranger=await h.play({focus:'identity',recognition:'denied',social:'reject',contradiction:1},'answer');
  assert.ok(stranger.anger<=0.15);assert.equal(stranger.physical.health,3);
  const flirt=await h.play({social:'flirt'},'tease');assert.ok(flirt.anger<=stranger.anger);assert.equal(flirt.physical.health,3);
});

test('combat anger and injuries survive a restart',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'eddie-combat-'));
  try {const file=join(dir,'state.json');const h=harness(new EscapeStore(file));const s=h.store.get('t')!;s.anger=1;h.store.put(s);const hit=await h.play();
    const loaded=new EscapeStore(file).get('t')!;assert.equal(loaded.anger,hit.anger);assert.equal(loaded.physical.health,2);assert.equal(loaded.physical.weapon,'raised');
  } finally {rmSync(dir,{recursive:true,force:true});}
});
