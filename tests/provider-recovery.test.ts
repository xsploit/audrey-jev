import test from 'node:test';
import assert from 'node:assert/strict';
import {Engine} from '../src/engine.js';
import {Store} from '../src/state.js';
import {readConfig} from '../src/config.js';
import type {Signals,Event,Turn} from '../src/types.js';
const signals:Signals={spam:0,addressed:1,opportunity:1,answered:0,interest:1,memory:0,selfFact:0,valence:.5,arousal:.5,dominance:.5,reaction:'neutral',memoryRelevance:{}};
const now=1_800_000_000_000;
const event:Event={id:'one',channelId:'channel',userId:'user',displayName:'User',text:'Is the show animated?',direct:false,at:now};
const unavailable=()=>Object.assign(new Error('provider secret body'),{statusCode:503});
const result=()=>({signals,inputTokens:1,outputTokens:1,ms:1});
test('503 retries once, charges both evaluations and recovers the requested reply',async()=>{
  let calls=0;const sent:string[]=[];
  const engine=new Engine(readConfig({}).config,new Store(),{evaluate:async()=>{if(++calls===1)throw unavailable();return result();},write:async()=> 'It is an animated show.'},()=>now);
  const r=await engine.submit(event,async text=>{sent.push(text);return {id:'reply',speakerId:'bot',speaker:'Audrey',text,isBot:true,at:now};});
  assert.equal(calls,2);assert.equal(r.action,'replied');assert.equal(r.evaluationAttempts,2);
  assert.deepEqual(r.recoveredFailure,{category:'provider',status:503});assert.equal(engine.diagnostics('channel').budgets.evaluations.used,2);
  assert.deepEqual(sent,['It is an animated show.']);
});
test('persistent outage cannot authorize unsolicited replies',async()=>{
  let calls=0;const sent:string[]=[];
  const engine=new Engine(readConfig({}).config,new Store(),{evaluate:async()=>{calls++;throw unavailable();},write:async()=>assert.fail('no writer')},()=>now);
  const send=async(text:string):Promise<Turn>=>{sent.push(text);return {id:'notice',speakerId:'bot',speaker:'Audrey',text,isBot:true,at:now};};
  const r=await engine.submit(event,send);
  assert.equal(calls,2);assert.equal(r.noticeSent,undefined);assert.equal(r.reason,'evaluation-error');
  assert.equal(sent.length,0);assert.equal(engine.history.size,0);
  const next=await engine.submit({...event,id:'two',text:'Are you there?'},send);
  assert.equal(next.noticeSent,undefined);assert.equal(sent.length,0);
});
test('evaluation retry respects budget and pause changes',async()=>{
  let calls=0;
  const limited=new Engine({...readConfig({}).config,dryRun:true,maxEvaluationsPerHour:1},new Store(),{evaluate:async()=>{calls++;throw unavailable();}},()=>now);
  await limited.submit(event,async()=>assert.fail('dry run'));assert.equal(calls,1);
  const paused=new Engine(readConfig({}).config,new Store(),{evaluate:async()=>{paused.store.channel('channel').paused=true;throw unavailable();}},()=>now);
  const r=await paused.submit(event,async()=>assert.fail('paused'));
  assert.equal(r.reason,'paused-or-privacy-changed');assert.equal(paused.diagnostics('channel').budgets.evaluations.used,1);
});
