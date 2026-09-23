import test from 'node:test';
import assert from 'node:assert/strict';
import { mayProposeDm } from '../src/policy.js';
import { Engine } from '../src/engine.js';
import { Store } from '../src/state.js';
import { readConfig } from '../src/config.js';
import { Outbox } from '../src/outbox.js';
import type { Event, Signals } from '../src/types.js';
const signals: Signals = {spam:0,addressed:1,opportunity:1,answered:0,interest:1,memory:0,selfFact:0,valence:0.5,arousal:0.3,dominance:0.5,reaction:'neutral',memoryRelevance:{},toolIntent:1};
const event: Event={id:'event',channelId:'channel',userId:'user-b',displayName:'B',text:'Audrey, please draft a DM.',direct:true,canManageTools:true,at:1_800_000_000_000};
test('tool availability requires real authority, direct interaction and semantic intent',()=>{
  assert.equal(mayProposeDm(event,signals),true);
  assert.equal(mayProposeDm({...event,canManageTools:false},signals),false);
  assert.equal(mayProposeDm({...event,direct:false},signals),false);
  assert.equal(mayProposeDm(event,{...signals,toolIntent:0.4}),false);
  assert.equal(mayProposeDm(event,{...signals,spam:0.9}),false);
});
test('forget invalidates another user’s in-flight shared history too',async()=>{
  let release!:()=>void;let sent=false;
  const engine=new Engine({...readConfig({}).config,dryRun:false},new Store(),{
    evaluate:async()=>{await new Promise<void>(r=>{release=r;});return {signals,ms:1,inputTokens:1,outputTokens:1};},
  },()=>event.at);
  const result=engine.process(event,async()=>{sent=true;throw new Error('must not send');});
  engine.forgetUser('channel','user-a');release();
  assert.equal((await result).reason,'paused-or-privacy-changed');assert.equal(sent,false);
});
test('outbox provides an execution-time consent check after recipient lookup',async()=>{
  const recipient={userId:'123456789012345678',isDm:true,canManage:false};const admin={userId:'owner',isDm:true,canManage:true};
  let sent=false;let outbox:Outbox;
  outbox=new Outbox(undefined,async()=>1,async(_id,_text,authorized)=>{
    await outbox.command(recipient,'outreach','off');
    if(!authorized()) throw new Error('revoked');
    sent=true;
  });
  await outbox.command(recipient,'outreach','on');
  const proposal=await outbox.command(admin,'propose',`${recipient.userId} | hello`);
  const id=proposal.match(/PROPOSAL ([a-f0-9]+)/)![1]!;
  assert.match(await outbox.command(admin,'send',id),/failed/);assert.equal(sent,false);
});
test('outbox proposals expire, even when approved by their creator',async()=>{
  let now=1;const recipient={userId:'123456789012345678',isDm:true,canManage:false};const admin={userId:'owner',isDm:true,canManage:true};
  const outbox=new Outbox(undefined,async()=>1,async()=>assert.fail('expired draft sent'),()=>now);
  await outbox.command(recipient,'outreach','on');const proposal=await outbox.command(admin,'propose',`${recipient.userId} | hello`);
  const id=proposal.match(/PROPOSAL ([a-f0-9]+)/)![1]!;now+=300_001;
  assert.match(await outbox.command(admin,'send',id),/No unexpired/);
});
