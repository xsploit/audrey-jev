import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationTracker } from '../src/conversation.js';
import { conversationEvidence } from '../src/evidence.js';
import { loadReplyChain, type ReplyNode } from '../src/reply-chain.js';
import { Engine } from '../src/engine.js';
import { Store, baseline } from '../src/state.js';
import { readConfig } from '../src/config.js';
import { replyDecision } from '../src/policy.js';
import type { Event, Turn, ReplyChainTurn, EvaluationInput, Signals } from '../src/types.js';
const time=1_800_000_000_000;
const event=(id:string,userId='kai',at=time,extra:Partial<Event>={}):Event=>({id,userId,at,channelId:'general',displayName:'Same Name',text:`message ${id}`,direct:false,...extra});
const turn=(id:string,speakerId='kai',at=time,extra:Partial<Turn>={}):Turn=>({id,speakerId,at,speaker:'Same Name',text:`text ${id}`,isBot:false,...extra});
const quoted=(id:string,speakerId='kai',at=time,extra:Partial<ReplyChainTurn>={}):ReplyChainTurn=>({...turn(id,speakerId,at),channelId:'general',...extra});
const signals:Signals={spam:0,addressed:1,opportunity:1,answered:0,interest:1,memory:0,selfFact:0,valence:.5,arousal:.3,dominance:.5,reaction:'neutral',memoryRelevance:{}};
function say(tracker:ConversationTracker,e:Event) {
  const selection=tracker.select(e,e.at);
  tracker.record(e.channelId,turn(e.id,e.userId,e.at,{text:e.text,replyTo:e.replyTo}),selection.context,e.userId,e.at);
  return selection;
}
function input(e:Event,selection:ReturnType<ConversationTracker['select']>):EvaluationInput {
  return {event:e,botName:'Audrey',interests:'music',history:selection.history,context:selection.context,mood:{...baseline,updatedAt:e.at},memories:[]};
}

test('same display names and overlapping users keep separate working histories',()=>{
  const tracker=new ConversationTracker();
  const kai=say(tracker,event('k1','kai',time,{direct:true,text:'My synth is 140 BPM.'}));
  tracker.record('general',turn('a1','audrey',time+100,{isBot:true,replyTo:'k1',text:'Try a slower LFO.'}),kai.context,'kai',time+100);
  const nova=say(tracker,event('n1','nova',time+200,{direct:true,text:'My cake bakes at 180 degrees.'}));
  tracker.record('general',turn('a2','audrey',time+300,{isBot:true,replyTo:'n1',text:'Preheat the oven.'}),nova.context,'nova',time+300);
  const current=event('k2','kai',time+400,{text:'Can you explain that?'});
  const selected=tracker.select(current,current.at);
  assert.equal(selected.context.source,'speaker-continuation');
  assert.deepEqual(selected.history.map(t=>t.id),['k1','a1']);
  assert.ok(selected.context.ambient.some(t=>t.id==='n1'));
  assert.ok(!JSON.stringify(conversationEvidence(input(current,selected),true)).includes('oven'));
  assert.ok(JSON.stringify(conversationEvidence(input(current,selected))).includes('oven'));
});
test('explicit reply target overrides the current speaker’s unrelated recent topic',()=>{
  const tracker=new ConversationTracker();say(tracker,event('n1','nova',time,{text:'Use 180 degrees.'}));
  say(tracker,event('k1','kai',time+100,{direct:true,text:'The synth is broken.'}));
  const current=event('k2','kai',time+200,{replyTo:'n1',replyChain:[quoted('n1','nova',time,{text:'Use 180 degrees.'})],replyChainStatus:'complete'});
  const selected=tracker.select(current,current.at);
  assert.deepEqual(selected.history.map(t=>t.id),['n1']);assert.equal(selected.context.addressedToOther,true);
  assert.equal(replyDecision({...current,addressedToOther:true},signals,{...readConfig({}).config,allowProactive:true},false),'addressed-to-someone-else');
  assert.equal(replyDecision({...current,direct:true,addressedToOther:true},signals,readConfig({}).config,false),'reply');
});
test('old explicitly quoted parent is available after a cold start with its original age',()=>{
  const tracker=new ConversationTracker();const old=time-86_400_000;
  const current=event('new','kai',time,{replyTo:'old',replyChain:[quoted('old','nova',old,{text:'The old prototype used C major.'})],replyChainStatus:'complete',direct:true});
  const selected=tracker.select(current,time);const evidence=conversationEvidence(input(current,selected),true);
  assert.equal(selected.history[0]?.text,'The old prototype used C major.');assert.equal(evidence.history[0]?.ageSeconds,86400);
  assert.equal(selected.context.replyTargetUserId,'nova');
});
test('fresh fetched edit overrides cached text and deleted targets do not resurrect from cache',()=>{
  const tracker=new ConversationTracker();say(tracker,event('root','kai',time,{text:'old content'}));
  const fetched=event('reply','kai',time+100,{replyTo:'root',replyChain:[quoted('root','kai',time,{text:'edited content'})],replyChainStatus:'complete'});
  assert.equal(tracker.select(fetched,fetched.at).history[0]?.text,'edited content');
  const missing={...fetched,replyChain:[],replyChainStatus:'missing' as const};
  assert.equal(tracker.select(missing,missing.at).history.length,0);assert.equal(tracker.select(missing,missing.at).context.replyStatus,'missing');
});
test('replying to an old branch excludes later sibling chatter',()=>{
  const tracker=new ConversationTracker();const root=say(tracker,event('root','kai',time,{direct:true}));
  tracker.record('general',turn('old-answer','audrey',time+100,{isBot:true,replyTo:'root'}),root.context,'kai',time+100);
  say(tracker,event('new-topic','kai',time+200,{text:'Different topic: car engines.'}));
  const selected=tracker.select(event('reply','kai',time+300,{replyTo:'old-answer'}),time+300);
  assert.ok(selected.history.some(t=>t.id==='old-answer'));assert.ok(!selected.history.some(t=>t.id==='new-topic'));
});
test('speaker continuation expires and does not cross channels or DMs',()=>{
  const tracker=new ConversationTracker();say(tracker,event('root','kai',time,{direct:true}));
  assert.equal(tracker.select(event('late','kai',time+180_001),time+180_001).context.source,'new');
  assert.equal(tracker.select(event('dm','kai',time+1,{channelId:'dm',isDm:true,direct:true}),time+1).history.length,0);
  assert.equal(tracker.select(event('thread','kai',time+1,{channelId:'thread'}),time+1).history.length,0);
});
test('explicitly addressing Audrey leaves a previous human-to-human lane',()=>{
  const tracker=new ConversationTracker();say(tracker,event('nova','nova',time));
  const human=say(tracker,event('kai','kai',time+100,{replyTo:'nova'}));assert.equal(human.context.addressedToOther,true);
  const selected=tracker.select(event('audrey-now','kai',time+200,{direct:true}),time+200);
  assert.equal(selected.context.source,'new');assert.equal(selected.context.addressedToOther,false);
});
test('context text budget is bounded and the immediate target is prioritized',()=>{
  const tracker=new ConversationTracker();for(let i=0;i<20;i++) say(tracker,event(String(i),'kai',time+i,{text:'x'.repeat(2000)}));
  const current=event('reply','kai',time+50,{replyTo:'0',replyChain:[quoted('0','kai',time,{text:'target!'+ 'z'.repeat(2000)})],replyChainStatus:'complete'});
  const selection=tracker.select(current,current.at);
  assert.ok(selection.history.length<=10);assert.ok(selection.history.reduce((s,t)=>s+t.text.length,0)<=6000);
  assert.ok(selection.context.ambient.reduce((s,t)=>s+t.text.length,0)<=660);
  assert.ok(selection.history.some(t=>t.text.startsWith('target!')));
});
test('secret/cross-channel/future fetched parents are not included in model evidence',()=>{
  const tracker=new ConversationTracker();
  for(const bad of [quoted('root','kai',time-1,{text:'vck_'+'A'.repeat(30)}),quoted('root','kai',time-1,{channelId:'private-dm'}),quoted('root','kai',time+1)]) {
    const current=event('reply','kai',time,{replyTo:'root',replyChain:[bad],replyChainStatus:'complete'});
    const selection=tracker.select(current,time);
    assert.equal(selection.history.length,0);assert.equal(selection.context.replyStatus,'blocked');
    assert.equal('replyChain' in conversationEvidence(input(current,selection),true).current,false);
  }
});
test('forget cutoff survives restart and blocks re-fetching pre-forget conversation',()=>{
  const dir=mkdtempSync(join(tmpdir(),'audrey-context-'));
  try {
    const file=join(dir,'state.json');const store=new Store(file);
    const engine=new Engine(readConfig({}).config,store,{evaluate:async()=>({signals,ms:1,inputTokens:1,outputTokens:1})},()=>time);
    engine.forgetUser('general','kai');
    const reopened=new Store(file);assert.equal(reopened.channel('general').contextResetAt,time);
    const current=event('reply','kai',time+100,{replyTo:'root',replyChain:[quoted('root','nova',time-1,{text:'a forgotten fact'})],replyChainStatus:'complete'});
    assert.equal(new ConversationTracker().select(current,current.at,reopened.channel('general').contextResetAt).history.length,0);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
test('model errors no longer erase structural context for the next turn',async()=>{
  let now=time;const calls:EvaluationInput[]=[];
  const engine=new Engine({...readConfig({}).config,dryRun:true},new Store(),{evaluate:async i=>{calls.push(i);if(calls.length===1)throw new Error('offline');return {signals,ms:1,inputTokens:1,outputTokens:1};}},()=>now);
  const noSend=async()=>{throw new Error('dry');};await engine.submit(event('one','kai',now),noSend);now+=100;
  await engine.submit(event('two','kai',now),noSend);assert.ok(calls[1]?.history.some(t=>t.id==='one'));
});
test('classified spam cannot be reintroduced through the tracker',()=>{
  const tracker=new ConversationTracker();say(tracker,event('spam','kai',time));tracker.reject('general','spam',time);
  const current=event('reply','kai',time+100,{replyTo:'spam',replyChain:[quoted('spam','kai',time)],replyChainStatus:'complete'});
  assert.equal(tracker.select(current,current.at).history.length,0);
});
test('other bots are explicitly not Audrey in the evidence packet',()=>{
  const tracker=new ConversationTracker();const current=event('reply','kai',time,{replyTo:'other',replyChain:[quoted('other','another-bot',time-1,{isOtherBot:true})],replyChainStatus:'complete'});
  const evidence=conversationEvidence(input(current,tracker.select(current,time)),true);
  assert.equal(evidence.history[0]?.speakerRole,'OTHER_BOT');assert.equal(evidence.history[0]?.isBot,false);
});

const node=(id:string,at:number,parent?:string):ReplyNode=>({turn:quoted(id,'kai',at,{replyTo:parent}),parentChannelId:'general'});
test('reply fetch follows at most three ancestors in order, not a channel history dump',async()=>{
  const calls:string[]=[];const nodes:Record<string,ReplyNode>={a:node('a',time-1,'b'),b:node('b',time-2,'c'),c:node('c',time-3,'d'),d:node('d',time-4)};
  const result=await loadReplyChain({channelId:'general',messageId:'current',replyTo:'a',currentAt:time,fetch:async id=>{calls.push(id);return nodes[id]??null;}});
  assert.deepEqual(calls,['a','b','c']);assert.equal(result.status,'limited');
});
test('cross-channel references are blocked without a fetch',async()=>{
  let calls=0;const result=await loadReplyChain({channelId:'general',messageId:'new',replyTo:'old',referenceChannelId:'private',currentAt:time,fetch:async()=>{calls++;return null;}});
  assert.equal(calls,0);assert.equal(result.status,'blocked');
});
test('deleted/forbidden parents degrade gracefully',async()=>{
  for(const fetch of [async()=>null,async()=>{throw new Error('403');}]) {
    const result=await loadReplyChain({channelId:'general',messageId:'new',replyTo:'old',currentAt:time,fetch});
    assert.deepEqual(result,{turns:[],status:'missing'});
  }
});
test('reply fetch timeout returns without awaiting a hanging API',async()=>{
  const result=await loadReplyChain({channelId:'general',messageId:'new',replyTo:'old',currentAt:time,timeoutMs:20,fetch:()=>new Promise(()=>{})});
  assert.equal(result.status,'limited');assert.equal(result.turns.length,0);
});
test('reply cycles, future timestamps, sensitive text and reset cutoffs are blocked',async()=>{
  const cycle=await loadReplyChain({channelId:'general',messageId:'new',replyTo:'old',currentAt:time,fetch:async()=>node('old',time-1,'new')});assert.equal(cycle.status,'blocked');
  for(const turn of [quoted('old','kai',time+1),quoted('old','kai',time-1,{text:'vck_'+'A'.repeat(30)})]) {
    const result=await loadReplyChain({channelId:'general',messageId:'new',replyTo:'old',currentAt:time,fetch:async()=>({turn})});assert.equal(result.status,'blocked');assert.equal(result.turns.length,0);
  }
  const forgotten=await loadReplyChain({channelId:'general',messageId:'new',replyTo:'old',currentAt:time,fetch:async()=>node('old',time-1),allowed:t=>t.at>time});assert.equal(forgotten.status,'blocked');
});
