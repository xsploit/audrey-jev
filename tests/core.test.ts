import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../src/engine.js';
import { Store, baseline, decayMood, nudgeMood } from '../src/state.js';
import { decayDrives, nudgeDrives, spendSocialBattery } from '../src/drives.js';
import { control } from '../src/controls.js';
import { readConfig } from '../src/config.js';
import { SerialQueue, WindowBudget } from '../src/policy.js';
import { Outbox } from '../src/outbox.js';
import type { Backend, EvaluationInput, Signals, Event, Turn } from '../src/types.js';

const normal = (): Signals => ({spam:0.01,addressed:0.95,opportunity:0.9,answered:0.02,interest:0.8,memory:0.2,selfFact:0.1,valence:0.7,arousal:0.5,dominance:0.6,reaction:'attentive',memoryRelevance:{}});
function harness(dryRun = false) {
  let now = 1_800_000_000_000;
  let signals = normal();
  const calls: EvaluationInput[] = []; const writes: {memories:unknown}[] = []; const sent: string[] = [];
  const backend: Backend = {
    async evaluate(input) {calls.push(input);return {signals:{...signals},inputTokens:10,outputTokens:5,ms:1};},
    async write(_input,_signals,memories) {writes.push({memories});return 'Small win. What did you change?';},
  };
  const config = {...readConfig({}).config,dryRun,maxCallsPerMinute:60};
  const store = new Store();
  const engine = new Engine(config,store,backend,()=>now);
  const event = (changes: Partial<Event> = {}): Event => ({id:`m${now}`,channelId:'c',userId:'u',displayName:'Kai',text:'Audrey, I shipped the synth!',direct:true,at:now,...changes});
  const send = async (text: string): Promise<Turn> => {sent.push(text);return {id:`b${now}`,speakerId:'bot',speaker:'Audrey',text,isBot:true,at:now};};
  return {engine,store,backend,calls,writes,sent,event,send,setSignals:(s:Partial<Signals>)=>{signals={...signals,...s};},advance:(ms=60_001)=>{now+=ms;}};
}

test('dry run evaluates but never writes or sends',async()=>{
  const h=harness(true); const r=await h.engine.submit(h.event(),h.send);
  assert.equal(r.action,'would-reply');assert.equal(h.calls.length,1);assert.equal(h.writes.length,0);assert.equal(h.sent.length,0);
});
test('actual sent replies only are recorded as bot history',async()=>{
  const h=harness();await h.engine.submit(h.event(),h.send);
  assert.equal(h.sent.length,1);assert.equal(h.engine.history.get('c')?.filter(t=>t.isBot).length,1);
  h.advance();await h.engine.submit(h.event(),async()=>{throw new Error('denied');});
  assert.equal(h.engine.history.get('c')?.filter(t=>t.isBot).length,1);
});
test('exact duplicate is skipped before the API',async()=>{
  const h=harness();const e=h.event();await h.engine.submit(e,h.send);
  const r=await h.engine.submit(e,h.send);
  assert.equal(r.reason,'exact-duplicate');assert.equal(h.calls.length,1);
});
test('possible credential is never sent to a model',async()=>{
  const h=harness();const r=await h.engine.submit(h.event({text:'vck_'+ 'A'.repeat(30)}),h.send);
  assert.equal(r.reason,'possible-credential');assert.equal(h.calls.length,0);
});
test('spam cannot change mood, enter history, or propose memory',async()=>{
  const h=harness();h.store.user('c','u').enabled=true;h.setSignals({spam:0.99,memory:1,selfFact:1});
  const before={...h.store.channel('c').mood};const r=await h.engine.submit(h.event({direct:false}),h.send);
  assert.equal(r.reason,'spam');assert.deepEqual(h.store.channel('c').mood,before);assert.equal(h.engine.history.has('c'),false);assert.equal(h.store.user('c','u').pending.length,0);
});
test('interesting third-person mention need not trigger speech',async()=>{
  const h=harness();h.engine.config.allowProactive=false;h.setSignals({addressed:0.02,interest:1,opportunity:1});
  const r=await h.engine.submit(h.event({direct:false,text:'Audrey said that earlier'}),h.send);
  assert.equal(r.reason,'not-invited');assert.equal(h.sent.length,0);
});
test('direct metadata works even if semantic address score is low',async()=>{
  const h=harness();h.setSignals({addressed:0.01});const r=await h.engine.submit(h.event({isDm:true}),h.send);assert.equal(r.action,'replied');
});
test('direct replies and DMs bypass conversational cooldowns',async()=>{
  const h=harness();await h.engine.submit(h.event({isDm:true}),h.send);h.advance(1_000);
  assert.equal((await h.engine.submit(h.event({isDm:true,text:'a different question'}),h.send)).action,'replied');
  h.advance(1_500);assert.equal((await h.engine.submit(h.event({isDm:true,text:'another question now'}),h.send)).action,'replied');
});
test('API failure is fail-silent and not represented as an answer',async()=>{
  const h=harness();h.backend.evaluate=async()=>{throw new Error('offline');};
  assert.equal((await h.engine.submit(h.event({direct:false}),h.send)).reason,'evaluation-error');assert.equal(h.sent.length,0);assert.equal(h.engine.history.size,0);
});
test('memory requires opt-in AND review, with per-user isolation',async()=>{
  const h=harness(true);h.setSignals({memory:1,selfFact:1});await h.engine.submit(h.event(),h.send);
  assert.equal(h.store.channel('c').users.u,undefined);
  h.store.user('c','u').enabled=true;h.advance();const event=h.event({text:'I prefer ambient music.'});
  await h.engine.submit(event,h.send);assert.equal(h.store.user('c','u').pending.length,1);assert.equal(h.store.candidates('c','u').length,0);
  const ctx={channelId:'c',userId:'u',canManage:false,canManageMode:false};
  assert.match(control(h.engine,{...ctx,userId:'other'},'approve',event.id),/No pending/);
  control(h.engine,ctx,'approve',event.id);assert.equal(h.store.candidates('c','u').length,1);assert.equal(h.store.candidates('elsewhere','u').length,0);
});
test('quotations fail the separate self-fact gate',async()=>{
  const h=harness(true);h.store.user('c','u').enabled=true;h.setSignals({memory:1,selfFact:0.4});
  await h.engine.submit(h.event({text:'Nova said she likes ambient.'}),h.send);assert.equal(h.store.user('c','u').pending.length,0);
});
test('writer receives only relevant approved memories of current speaker',async()=>{
  const h=harness();const user=h.store.user('c','u');user.enabled=true;user.approved=[{id:'a',text:'ambient',createdAt:1},{id:'b',text:'coffee',createdAt:2}];
  h.setSignals({memoryRelevance:{a:0.9,b:0.1}});await h.engine.submit(h.event(),h.send);
  assert.deepEqual(h.writes[0]?.memories,[user.approved[0]]);
});
test('forget during an in-flight evaluation blocks later writing',async()=>{
  const h=harness();let release!:()=>void;
  const original=h.backend.evaluate;h.backend.evaluate=async i=>{await new Promise<void>(r=>{release=r;});return original(i);};
  const pending=h.engine.process(h.event(),h.send);h.engine.forgetUser('c','u');release();
  assert.equal((await pending).reason,'paused-or-privacy-changed');assert.equal(h.sent.length,0);
});
test('pause during writer prevents sending',async()=>{
  const h=harness();h.backend.write=async()=>{h.store.channel('c').paused=true;return 'draft';};
  assert.equal((await h.engine.submit(h.event(),h.send)).reason,'paused-or-privacy-changed');assert.equal(h.sent.length,0);
});
test('budget is enforced before inference',async()=>{
  const h=harness(true);h.engine.config.maxEvaluationsPerHour=1;
  // Budgets are constructed once from config.
  const engine=new Engine({...h.engine.config,maxEvaluationsPerHour:1},h.store,h.backend,()=>h.event().at);
  await engine.submit(h.event({direct:false}),h.send);h.advance();assert.equal((await engine.submit(h.event({direct:false,text:'new'}),h.send)).reason,'evaluation-budget');assert.equal(h.calls.length,1);
});
test('mood bounded and decays toward baseline using elapsed time',()=>{
  let mood={...baseline,updatedAt:0};for(let i=0;i<1000;i++) mood=nudgeMood(mood,{valence:1,arousal:1,dominance:0},0);
  assert.ok(mood.valence<=1 && mood.arousal<=1 && mood.dominance>=0);
  const decayed=decayMood(mood,600_000);assert.ok(Math.abs(decayed.valence-(baseline.valence+(mood.valence-baseline.valence)/2))<1e-9);
});
test('fictional drives are bounded and recover, not biological claims',()=>{
  let drives=decayDrives(undefined,0);for(let i=0;i<100;i++) drives=spendSocialBattery(nudgeDrives(drives,normal(),0));
  assert.equal(drives.socialBattery,0);assert.ok(decayDrives(drives,1_200_000).socialBattery>0);assert.ok(drives.tension>=0 && drives.tension<=1);
});
test('invalid config rejects unsafe accidental values',()=>{
  assert.throws(()=>readConfig({DRY_RUN:'maybe'}));assert.throws(()=>readConfig({MAX_CALLS_PER_MINUTE:'-1'}));assert.throws(()=>readConfig({DISCORD_CHANNEL_IDS:'general'}));
});
test('state persisted with owner-only permissions and corrupt state is not overwritten',()=>{
  const dir=mkdtempSync(join(tmpdir(),'audrey-'));const file=join(dir,'state.json');
  try {const store=new Store(file);store.user('c','u').enabled=true;store.save();assert.equal(new Store(file).user('c','u').enabled,true);assert.equal(statSync(file).mode&0o777,0o600);
    writeFileSync(file,'broken');assert.throws(()=>new Store(file));assert.equal(readFileSync(file,'utf8'),'broken');}finally{rmSync(dir,{recursive:true,force:true});}
});
test('bounded queue survives rejected jobs',async()=>{
  const q=new SerialQueue(1);let release!:()=>void;const first=q.add(()=>new Promise<void>(r=>{release=r;}));
  await assert.rejects(q.add(async()=>undefined));await Promise.resolve();release();await first;await new Promise(r=>setImmediate(r));
  await assert.rejects(q.add(async()=>{throw new Error('expected');}));await new Promise(r=>setImmediate(r));assert.equal(await q.add(async()=>42),42);
});
test('window budget refills after window',()=>{const b=new WindowBudget(1,1000);assert.equal(b.take(0),true);assert.equal(b.take(1),false);assert.equal(b.take(1000),true);});

const target='123456789012345678';
const admin={userId:'admin',isDm:true,canManage:true};
test('outbox enforces consent before calling Jev and admin authority',async()=>{
  let judged=0;const outbox=new Outbox(undefined,async()=>{judged++;return 1;},async()=>undefined);
  assert.match(await outbox.command(admin,'propose',`${target} | hello`),/not opted/);
  assert.match(await outbox.command({...admin,canManage:false},'propose',`${target} | hello`),/require/);assert.equal(judged,0);
});
test('approved outbox actions are exact, actor-bound and single-use',async()=>{
  const sent:unknown[]=[];const outbox=new Outbox(undefined,async()=>0.99,async(id,text)=>{sent.push({id,text});});
  await outbox.command({userId:target,isDm:true,canManage:false},'outreach','on');
  const proposal=await outbox.command(admin,'propose',`${target} | hello there`);const id=proposal.match(/PROPOSAL ([a-f0-9]+)/)![1]!;
  assert.match(await outbox.command({...admin,userId:'other'},'send',id),/No unexpired/);assert.equal(sent.length,0);
  assert.match(await outbox.command(admin,'send',id),/sent/);assert.deepEqual(sent,[{id:target,text:'hello there'}]);
  await outbox.command(admin,'send',id);assert.equal(sent.length,1);
});
test('revoked recipient consent cancels drafts',async()=>{
  let sent=0;const outbox=new Outbox(undefined,async()=>1,async()=>{sent++;});const recipient={userId:target,isDm:true,canManage:false};
  await outbox.command(recipient,'outreach','on');const draft=await outbox.command(admin,'propose',`${target} | hello`);const id=draft.match(/PROPOSAL ([a-f0-9]+)/)![1]!;
  await outbox.command(recipient,'outreach','off');await outbox.command(admin,'send',id);assert.equal(sent,0);
});
test('failed or low-confidence tool judgments never create executable drafts',async()=>{
  for(const judge of [async()=>0.6,async()=>{throw new Error('offline');}]) {const outbox=new Outbox(undefined,judge,async()=>assert.fail('must not send'));
    await outbox.command({userId:target,isDm:true,canManage:false},'outreach','on');await outbox.command(admin,'propose',`${target} | hi`);assert.match(await outbox.command(admin,'outbox',''),/No pending/);}
});
