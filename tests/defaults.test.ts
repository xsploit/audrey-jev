import test from 'node:test';
import assert from 'node:assert/strict';
import { readConfig } from '../src/config.js';
import { Engine } from '../src/engine.js';
import { Store } from '../src/state.js';
import { control } from '../src/controls.js';
import type { Signals } from '../src/types.js';
const owner='123456789012345678';
const guild='100000000000000001';
const signals: Signals={spam:0,addressed:0,opportunity:0,answered:0,interest:0.8,memory:0.8,selfFact:1,valence:0.5,arousal:0.3,dominance:0.5,reaction:'neutral',memoryRelevance:{}};
test('whole-guild and owner-default memory settings are explicit validated lists',()=>{
  const settings=readConfig({PASSIVE_GUILD_IDS:guild,MEMORY_DEFAULT_USER_IDS:owner,ALLOW_PROACTIVE:'true'});
  assert.ok(settings.passiveGuilds.has(guild));assert.equal(settings.passiveGuilds.has('other'),false);
  assert.deepEqual(settings.config.defaultMemoryUserIds,[owner]);assert.equal(settings.config.allowProactive,true);
  assert.throws(()=>readConfig({PASSIVE_GUILD_IDS:'My Test Server'}));assert.throws(()=>readConfig({MEMORY_DEFAULT_USER_IDS:'everyone'}));
  assert.equal(readConfig({}).passiveGuilds.size,0);
});
test('requested defaults enable owner proposals, not everyone; forget remains off',async()=>{
  let now=1_800_000_000_000;
  const store=new Store();
  const engine=new Engine({...readConfig({MEMORY_DEFAULT_USER_IDS:owner}).config,dryRun:true},store,
    {evaluate:async()=>({signals,inputTokens:1,outputTokens:1,ms:1})},()=>now);
  const event=(userId:string,text:string)=>({id:String(now),channelId:'channel',userId,displayName:'name',text,direct:false,at:now});
  const noSend=async()=>{throw new Error('dry run must not send');};
  await engine.submit(event(owner,'I prefer ambient music.'),noSend);
  assert.equal(store.user('channel',owner).enabled,true);assert.equal(store.user('channel',owner).pending.length,1);
  now+=1000;await engine.submit(event('another','I prefer jazz.'),noSend);assert.equal(store.channel('channel').users.another,undefined);
  engine.forgetUser('channel',owner);now+=1000;
  await engine.submit(event(owner,'I prefer ambient for coding.'),noSend);
  assert.equal(store.user('channel',owner).enabled,false);assert.equal(store.user('channel',owner).pending.length,0);
  control(engine,{channelId:'channel',userId:owner,canManage:false,canManageMode:false},'status');
  assert.equal(store.user('channel',owner).enabled,false);
});
test('default-enabled owner can explicitly remember from the first control',()=>{
  const store=new Store();const engine=new Engine(readConfig({MEMORY_DEFAULT_USER_IDS:owner}).config,store,{evaluate:async()=>{throw new Error('no API');}});
  const result=control(engine,{channelId:'new-dm',userId:owner,canManage:false,canManageMode:true},'remember','I like synthesizers.');
  assert.match(result,/Saved/);assert.equal(store.user('new-dm',owner).approved.length,1);
});
