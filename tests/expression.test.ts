import test from 'node:test';
import assert from 'node:assert/strict';
import { compileExpression, generationSettings, type Expression } from '../src/expression.js';
import { AutonomousClock } from '../src/autonomy.js';
import { Engine } from '../src/engine.js';
import { Store } from '../src/state.js';
import { readConfig } from '../src/config.js';
import type { Signals, EvaluationInput, Event, Turn } from '../src/types.js';
const expression:Expression={emotions:{curious:.9,tender:.8,frustrated:.7,excited:.2},behavior:'explore',pace:'brief',creativity:'playful',reasoning:'minimal'};
const signals:Signals={spam:0,addressed:1,opportunity:1,answered:0,interest:1,memory:1,selfFact:1,valence:.9,arousal:.8,dominance:.8,reaction:'attentive',memoryRelevance:{},expression};
const event:Event={id:'human',channelId:'c',userId:'u',displayName:'User',text:'I got the synthesizer running.',direct:true,at:1_800_000_000_000};
const input:EvaluationInput={botName:'Audrey',interests:'music',event,history:[],memories:[],mood:{valence:.4,arousal:.5,dominance:.5,updatedAt:event.at},drives:{curiosity:.8,socialBattery:.2,tension:.2,updatedAt:event.at}};
test('mixed feelings compile into contextual descriptions with bounded selection',()=>{
  const compiled=compileExpression(input,signals);
  assert.deepEqual(compiled.active,['curious','tender','frustrated']);
  assert.match(compiled.text,/Interested but drained/);
  assert.match(compiled.text,/Warmth and frustration coexist/);
  assert.doesNotMatch(compiled.text,/Excitement:/);
});
test('conflicting activation descriptions select the stronger cue',()=>{
  const compiled=compileExpression(input,{...signals,expression:{...expression,emotions:{content:.8,excited:.9}}});
  assert.deepEqual(compiled.active,['excited']);
});
test('provider settings stay within the known model capability map',()=>{
  const gemini=generationSettings('google/gemini-3-flash',expression);
  assert.equal(gemini.temperature,1);
  assert.equal(gemini.providerOptions?.google.thinkingConfig.thinkingLevel,'minimal');
  assert.equal(generationSettings('unknown/reasoning-model',expression).temperature,undefined);
  assert.ok(generationSettings('google/gemini-3-flash',{...expression,pace:'considered'}).maxOutputTokens>gemini.maxOutputTokens);
});
test('autonomy defaults on with ordinary pause and dry mode still available',()=>{
  assert.equal(readConfig({}).config.allowProactive,true);
  assert.equal(readConfig({}).config.dryRun,false);
  assert.equal(readConfig({ALLOW_PROACTIVE:'false',DRY_RUN:'true'}).config.allowProactive,false);
});
test('idle opportunities require a recent human turn and cannot self-repeat',()=>{
  const clock=new AutonomousClock(), now=event.at;
  assert.equal(clock.next(now),undefined);
  clock.observe('c',now);
  assert.equal(clock.next(now+120_000),undefined);
  assert.equal(clock.next(now+180_000),'c');
  assert.equal(clock.current('c',now+180_000),true);
  assert.equal(clock.next(now+500_000),undefined);
  clock.observe('c',now+500_000);
  assert.equal(clock.current('c',now+180_000),false);
  assert.equal(clock.next(now+680_000),'c');
  clock.observe('old',now);
  assert.equal(clock.next(now+1_000_000),undefined);
});
test('autonomous turn uses real history, adds no fictional human message and does not manufacture emotion',async()=>{
  let now=event.at;
  const store=new Store();let evaluated:EvaluationInput|undefined;
  const engine=new Engine(readConfig({}).config,store,{
    evaluate:async i=>{evaluated=i;return {signals,inputTokens:1,outputTokens:1,ms:1};},
    write:async()=> 'That synth could make an interesting bass patch.',
  },()=>now);
  const send=async(text:string):Promise<Turn>=>({id:`bot-${now}`,speakerId:'bot',speaker:'Audrey',text,isBot:true,at:now});
  await engine.submit(event,send);
  const before=store.channel('c').mood;
  now+=180_000;
  const tick:Event={...event,id:'tick',userId:'bot',displayName:'Internal tick',direct:false,autonomous:true,at:now,text:'Consider a fresh contribution.'};
  assert.equal((await engine.submit(tick,send)).action,'replied');
  assert.ok(evaluated?.history.some(t=>t.id==='human'));
  assert.deepEqual(evaluated?.memories,[]);
  assert.equal(engine.history.get('c')?.some(t=>t.id==='tick'),false);
  assert.ok(store.channel('c').mood.valence<before.valence);
  assert.equal(store.channel('c').users.bot,undefined);
  engine.forgetUser('c','u');now+=180_000;
  assert.equal((await engine.submit({...tick,id:'tick2',at:now},send)).reason,'no-recent-human-context');
});
test('autonomous opportunity cannot bypass a quiet judgment via addressed score',async()=>{
  let now=event.at;
  const engine=new Engine(readConfig({}).config,new Store(),{
    evaluate:async()=>({signals:{...signals,opportunity:0},inputTokens:1,outputTokens:1,ms:1}),
    write:async()=> 'hello',
  },()=>now);
  const send=async(text:string):Promise<Turn>=>({id:'sent',speakerId:'bot',speaker:'Audrey',text,isBot:true,at:now});
  await engine.submit(event,send);now+=180_000;
  assert.equal((await engine.submit({...event,id:'tick',text:'Idle tick',direct:false,autonomous:true,at:now},async()=>assert.fail('must remain silent'))).reason,'autonomous-quiet');
});
