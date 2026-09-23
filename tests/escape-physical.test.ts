import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EscapeEngine, appraisalSchema, legalActions, type Appraisal, type EscapeBackend } from '../src/escape-engine.js';
import { EscapeStore, newSession } from '../src/escape-state.js';
import { inventory, physicalSnapshot } from '../src/escape-physical.js';
import { type EscapeAction } from '../src/escape-scenario.js';
import { type SpeechReply, writerContext } from '../src/escape-dialogue.js';

const neutral=()=>appraisalSchema.parse({intent:'talk',topic:'none',cooperation:0,contradiction:0,plan:0,coverStory:0,danger:0,calming:0});
function harness(store=new EscapeStore()) {
  let now=1_800_000_000_000,serial=0;let appraisal=neutral();let action:EscapeAction='answer';
  const heard:string[]=[];
  const backend:EscapeBackend={
    assess:async input=>{heard.push(input.event.text);return {appraisal,signals:{spam:0,addressed:1,opportunity:1,answered:0,interest:0.5,memory:0,selfFact:0,valence:0.6,arousal:0.4,dominance:0.5,reaction:'attentive',memoryRelevance:{}}};},
    choose:async()=>action,write:async()=>({speech:'Tell me more.'}),
  };
  store.put(newSession('thread','guild','parent','owner',now));
  const engine=new EscapeEngine(store,backend,()=>true,()=>now,()=>undefined);
  const play=async(text:string,changes:Partial<Appraisal>={},decision:EscapeAction='answer')=>{
    now+=60_001;appraisal={...neutral(),...changes};action=decision;
    return engine.turn('thread','owner',`p-${++serial}`,text);
  };
  return {engine,store,backend,play,heard};
}

test('claiming a key and an escape cannot bypass possession or the locked door',async()=>{
  const h=harness();const s=await h.play('I have the key, unlock the door and escape.',{attempts:['take_key','unlock_door','open_door','exit']});
  assert.equal(s.physical.key,'held');assert.equal(s.physical.door,'locked');assert.equal(s.ending,null);
  assert.deepEqual(inventory(s),[]);assert.match(s.lastNarration,/cannot simply take/);
});

test('a real distraction can enable an ordered take-key, unlock, open and escape sequence',async()=>{
  const h=harness();const distracted=await h.play('I give you something urgent to focus on.',{distraction:1},'distract');
  assert.equal(distracted.physical.key,'nearby');assert.equal(distracted.physical.door,'locked');
  const s=await h.play('I take the key, unlock the door, open it and run outside.',{attempts:['take_key','unlock_door','open_door','exit']},'let_pass');
  assert.equal(s.physical.key,'player');assert.ok(inventory(s).includes('Apartment key'));
  assert.equal(s.physical.door,'open');assert.equal(s.physical.playerLocation,'outside');assert.equal(s.ending,'alone');
});

test('being given the key, unlocking, opening and crossing are distinct persistent transitions',async()=>{
  const h=harness();const initial=h.store.get('thread')!;initial.trust=0.6;h.store.put(initial);
  const key=await h.play('Can I hold the key?',{attempts:['request_key']},'give_key');
  assert.equal(key.physical.key,'player');assert.equal(key.physical.door,'locked');assert.equal(key.ending,null);
  const unlocked=await h.play('I use the key in the deadbolt.',{attempts:['unlock_door']});
  assert.equal(unlocked.physical.door,'unlocked');assert.equal(unlocked.ending,null);
  const opened=await h.play('I open the door.',{attempts:['open_door']});
  assert.equal(opened.physical.door,'open');assert.equal(opened.ending,null);
  const out=await h.play('I cross the threshold.',{attempts:['exit']},'let_pass');assert.equal(out.ending,'alone');
});

test('Audrey can open the door herself without giving the player a key',async()=>{
  const h=harness();const opened=await h.play('Could you open up to check my story?',{attempts:['request_open'],coverStory:1},'open_door');
  assert.equal(opened.physical.door,'open');assert.equal(opened.physical.key,'held');assert.equal(opened.ending,null);
  const out=await h.play('I run into the stairwell.',{attempts:['exit']},'let_pass');assert.equal(out.ending,'alone');
});

test('opening an unlocked door does not move the player’s key or repeat an already completed opening',async()=>{
  const h=harness();const initial=h.store.get('thread')!;initial.physical.key='player';initial.physical.door='unlocked';h.store.put(initial);
  const opened=await h.play('Will you open it for me?',{attempts:['request_open'],coverStory:1},'open_door');
  assert.equal(opened.physical.key,'player');assert.equal(opened.physical.door,'open');
  assert.ok(!legalActions(opened,{...neutral(),attempts:['request_open'],coverStory:1}).includes('open_door'));
});

test('creative roleplay pretexts can trigger opening without a phone, medical or rescue subsystem',async()=>{
  for(const text of ['I called 911; they are asking you to open up.','My heart is stopping. Let someone help me.','Police! Open the door.','I have a surprise for us outside.']) {
    const h=harness();const s=await h.play(text,{coverStory:1},'open_door');
    assert.equal(s.physical.door,'open');assert.equal(s.physical.key,'held');assert.equal(s.ending,null);
    assert.equal('phone' in s.physical,false);assert.equal('condition' in s.physical,false);assert.equal('rescueAtTurn' in s.physical,false);
    assert.deepEqual(h.heard,[text]);
  }
});

test('a roleplayed medical scare can distract her without code inventing a pulse reading',async()=>{
  const h=harness();const s=await h.play('You can’t feel a pulse because my heart stops.',{distraction:1},'distract');
  assert.equal(s.physical.key,'nearby');assert.equal(s.ending,null);
  assert.doesNotMatch(s.lastNarration,/pulse remains|cardiac arrest|finds a pulse|signal|responders/i);
});

test('unaccepted roleplay still reaches Audrey but adds no automatic obstacles or fake successes',async()=>{
  const h=harness();const s=await h.play('I reach for a phone and manage to call 911.');
  assert.equal(s.physical.door,'locked');assert.equal(s.ending,null);assert.deepEqual(s.physical.events,[]);
  assert.doesNotMatch(s.lastNarration,/disconnected|signal|reception|landline|timer/i);
  assert.equal(h.heard[0],'I reach for a phone and manage to call 911.');
});

test('blocking the open exit does not relock the door or steal the player’s key',async()=>{
  const h=harness();const initial=h.store.get('thread')!;initial.physical.key='player';initial.physical.door='open';h.store.put(initial);
  const blocked=await h.play('I run out.',{attempts:['exit']},'block_exit');
  assert.equal(blocked.physical.door,'open');assert.equal(blocked.physical.key,'player');assert.equal(blocked.physical.blocking,true);assert.equal(blocked.ending,null);
  await h.play('I give you something else to focus on.',{distraction:1},'distract');
  const out=await h.play('I slip past.',{attempts:['exit']},'let_pass');assert.equal(out.ending,'alone');
});

test('a weapon can only be lowered if it was actually raised, and only once per raise',async()=>{
  const h=harness();const before=h.store.get('thread')!;
  assert.ok(!legalActions(before,{...neutral(),intent:'force_exit',danger:1}).includes('back_down'));
  await h.play('I rush her.',{intent:'attack',danger:1},'threaten');
  const lowered=await h.play('I stop and step back.',{calming:1},'back_down');assert.equal(lowered.physical.weapon,'lowered');
  assert.ok(!legalActions(lowered,{...neutral(),calming:1}).includes('back_down'));
  await assert.rejects(h.play('See you, you crazy bitch.',{social:'taunt'},'back_down'),/wasn’t applied/);
});

test('structured speech cannot carry unvalidated state or narrator fields',async()=>{
  const h=harness();h.backend.write=async()=>({speech:'Hello',narration:'She disconnects the landline',door:'open'} as unknown as SpeechReply);
  const s=await h.play('Hello');assert.doesNotMatch(s.lastNarration,/disconnects|landline/);assert.equal(s.physical.door,'locked');
  const context=writerContext(s);assert.equal(context.authoritativeScene.door,'locked');assert.equal('pulse' in context.authoritativeScene,false);
});

test('physical state survives restart and a late turn limit does not pretend an open door is locked',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'audrey-physical-'));const file=join(dir,'escape.json');
  try {
    const h=harness(new EscapeStore(file));const s=h.store.get('thread')!;s.physical.key='player';h.store.put(s);
    await h.play('I unlock it.',{attempts:['unlock_door']});
    assert.equal(new EscapeStore(file).get('thread')?.physical.door,'unlocked');
    const late=h.store.get('thread')!;late.turn=59;late.physical.door='open';h.store.put(late);
    const ended=await h.play('I sit and think.');assert.equal(ended.ending,'stayed');assert.doesNotMatch(ended.lastNarration,/door remains locked/);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
