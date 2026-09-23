import test from 'node:test';
import assert from 'node:assert/strict';
import { EscapeStore, newSession } from '../src/escape-state.js';
import { EscapeEngine, appraisalSchema, type EscapeBackend, type Appraisal } from '../src/escape-engine.js';
import { OPENING, type EscapeAction } from '../src/escape-scenario.js';
import { speechFromNarration, type WriterHints } from '../src/escape-dialogue.js';

const neutral=()=>appraisalSchema.parse({intent:'talk',topic:'none',cooperation:0,contradiction:0,plan:0,coverStory:0,danger:0,calming:0});
function harness() {
  const store=new EscapeStore();let now=1_800_000_000_000,serial=0;
  store.put(newSession('t','g','p','u',now));let a=neutral(),action:EscapeAction='answer';
  const calls:{action:EscapeAction;health:number;weapon:string;ending:string|null;hints?:WriterHints}[]=[];
  const backend:EscapeBackend={
    assess:async()=>({appraisal:a,signals:{spam:0,addressed:1,opportunity:1,answered:0,interest:0.5,memory:0,selfFact:0,valence:0.2,arousal:0.8,dominance:0.5,reaction:'attentive',memoryRelevance:{}}}),
    choose:async()=>action,
    write:async(s,_text,act,_memories,hints)=>{calls.push({action:act,health:s.physical.health,weapon:s.physical.weapon,ending:s.ending,hints});return {speech:`Generated ${act} reaction ${calls.length}.`};},
  };
  const engine=new EscapeEngine(store,backend,()=>true,()=>now,()=>undefined);
  const play=(changes:Partial<Appraisal>={},choice:EscapeAction='answer')=>{a={...neutral(),...changes};action=choice;now+=60_001;return engine.turn('t','u',`m${++serial}`,'Current player message');};
  return {store,backend,engine,calls,play};
}

test('knife threats, backing down, stabs and death all use generated speech after resolution',async()=>{
  const h=harness();
  await h.play({intent:'attack',danger:1},'threaten');assert.equal(h.calls.at(-1)?.weapon,'raised');
  await h.play({calming:1,social:'reassure'},'back_down');assert.equal(h.calls.at(-1)?.weapon,'lowered');
  const s=h.store.get('t')!;s.anger=1;h.store.put(s);
  const first=await h.play({},'stab');assert.equal(h.calls.at(-1)?.health,2);assert.match(first.lastNarration,/Generated stab reaction/);
  await h.play({},'stab');const dead=await h.play({},'stab');
  assert.equal(h.calls.at(-1)?.health,0);assert.equal(h.calls.at(-1)?.ending,'dead');assert.match(dead.lastNarration,/Generated stab reaction/);
  assert.equal(h.calls.length,5);
});

test('a repeated line is regenerated once with explicit avoidance context',async()=>{
  const h=harness();const s=h.store.get('t')!;s.lastNarration='“Stay with me!”';h.store.put(s);
  let count=0;
  h.backend.write=async(_s,_text,_action,_memories,hints)=>{
    count++;if(count===1)return {speech:'STAY WITH ME.'};
    assert.equal(hints?.retry,true);assert.ok(hints?.avoid.includes('Stay with me!'));return {speech:'You keep looking at the door instead of answering me.'};
  };
  const result=await h.play();assert.equal(count,2);assert.equal(speechFromNarration(result.lastNarration),'You keep looking at the door instead of answering me.');
});

test('repeated or unavailable drafts never fall back to a scripted NPC line',async()=>{
  const h=harness();const s=h.store.get('t')!;s.lastNarration='“Stay with me.”';s.anger=1;h.store.put(s);
  let calls=0;h.backend.write=async()=>{calls++;return {speech:'Stay with me!'};};
  const result=await h.play({},'stab');assert.equal(calls,2);assert.equal(result.physical.health,2);
  assert.match(result.lastNarration,/stabs you/);assert.match(result.lastNarration,/Dialogue generation is temporarily unavailable/);
  assert.equal(speechFromNarration(result.lastNarration),'');
});

test('an ungrounded draft is repaired rather than replaced with a canned response',async()=>{
  const h=harness();let calls=0;
  h.backend.write=async(_s,_text,_action,_memories,hints)=>{
    if(++calls===1)throw Object.assign(new Error('Rejected draft'),{name:'UngroundedSpeechError'});
    assert.equal(hints?.retry,true);assert.match(hints?.repair??'',/resolved scene/);return {speech:'Tell me why you want that key.'};
  };
  const result=await h.play();assert.equal(calls,2);assert.equal(speechFromNarration(result.lastNarration),'Tell me why you want that key.');
});

test('the opening has authored scene description but its greeting is generated',async()=>{
  const h=harness();assert.equal(speechFromNarration(OPENING),'');
  const intro=await h.engine.opening(h.store.get('t')!);
  assert.equal(h.calls[0]?.action,'greet');assert.match(intro.lastNarration,/Generated greet reaction/);
  assert.equal(intro.turn,0);assert.deepEqual(intro.clues,[]);
});

test('an unavailable opening writer produces no fake character greeting',async()=>{
  const h=harness();h.backend.write=async()=>{throw new Error('Provider offline');};
  const intro=await h.engine.opening(h.store.get('t')!);
  assert.match(intro.lastNarration,/unfamiliar living room/);assert.equal(speechFromNarration(intro.lastNarration),'');
});
