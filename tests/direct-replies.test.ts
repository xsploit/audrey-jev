import test from 'node:test';
import assert from 'node:assert/strict';
import {Engine} from '../src/engine.js';
import {Store} from '../src/state.js';
import {readConfig} from '../src/config.js';
import type {Event,Signals,Turn} from '../src/types.js';
const now=1_800_000_000_000;
const event:Event={id:'one',channelId:'channel',userId:'user',displayName:'User',text:'Answer again please',direct:true,mentioned:true,at:now};
const signals:Signals={spam:1,addressed:0,opportunity:0,answered:1,interest:0,memory:1,selfFact:1,valence:.5,arousal:.5,dominance:.5,reaction:'neutral',memoryRelevance:{}};
const send=async(text:string):Promise<Turn>=>({id:'reply',speakerId:'bot',speaker:'Audrey',text,isBot:true,at:now});
test('mentions and replies bypass all response scores, cooldown and repeated-text filtering',async()=>{
  const engine=new Engine(readConfig({}).config,new Store(),{evaluate:async()=>({signals,inputTokens:1,outputTokens:1,ms:1}),write:async()=> 'Actual generated answer'},()=>now);
  engine.store.user('channel','user').enabled=true;
  assert.equal((await engine.submit(event,send)).action,'replied');
  assert.equal((await engine.submit({...event,id:'two',mentioned:false,replyTo:'reply'},send)).action,'replied');
  assert.equal(engine.store.user('channel','user').pending.length,0);
  assert.equal((await engine.submit({...event,id:'two'},send)).reason,'exact-duplicate');
});
test('Jev outage cannot block direct writer or grant memory/tool authority',async()=>{
  let evaluations=0,writes=0;
  const engine=new Engine(readConfig({}).config,new Store(),{
    evaluate:async()=>{evaluations++;throw Object.assign(new Error('secret'),{statusCode:503});},
    write:async(_input,s,memories)=>{writes++;assert.equal(s.toolIntent,0);assert.equal(s.memory,0);assert.deepEqual(memories,[]);return 'Writer still answers';},
  },()=>now);
  const receipt=await engine.submit(event,send);
  assert.equal(receipt.action,'replied');assert.equal(receipt.stateFallback,'jev-error');assert.equal(receipt.evaluation,undefined);
  assert.equal(evaluations,1);assert.equal(writes,1);assert.equal(receipt.failure?.status,503);
});
test('exhausted Jev budget and last minute slot still permit a direct writer',async()=>{
  let evaluated=0;
  const engine=new Engine({...readConfig({}).config,maxCallsPerMinute:1},new Store(),{
    evaluate:async()=>{evaluated++;throw new Error('must skip');},write:async()=> 'Answer',
  },()=>now);
  const receipt=await engine.submit(event,send);
  assert.equal(receipt.action,'replied');assert.equal(receipt.stateFallback,'jev-budget');assert.equal(evaluated,0);
  assert.equal(engine.diagnostics('channel').budgets.calls.used,1);
});
test('direct fallback still respects pause during evaluator and dry mode',async()=>{
  const engine=new Engine(readConfig({}).config,new Store(),{
    evaluate:async()=>{engine.store.channel('channel').paused=true;throw new Error('down');},write:async()=>assert.fail('paused'),
  },()=>now);
  assert.equal((await engine.submit(event,async()=>assert.fail('paused'))).reason,'paused-or-privacy-changed');
});
