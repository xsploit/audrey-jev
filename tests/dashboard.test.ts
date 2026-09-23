import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageFlags, type Client, type Interaction } from 'discord.js';
import { Dashboard, renderDashboard, decisionLabel, reasonText, VIEWS, type Panel } from '../src/dashboard.js';
import { Engine } from '../src/engine.js';
import { Store } from '../src/state.js';
import { AutonomousClock } from '../src/autonomy.js';
import { readConfig } from '../src/config.js';
import type { Event, Signals, Turn } from '../src/types.js';
const channelId='123456789012345678', guildId='223456789012345678', messageId='323456789012345678';
const panel:Panel={channelId,guildId,messageId,view:'overview'};
const signals:Signals={spam:0,addressed:.1,opportunity:.2,answered:0,interest:.8,memory:0,selfFact:0,valence:.6,arousal:.5,dominance:.5,reaction:'attentive',memoryRelevance:{},
  expression:{emotions:{curious:.9,amused:.7,content:.6,excited:.4,tender:.5,disappointed:.3,frustrated:.2,uneasy:.2,surprised:.3,relieved:.4,reflective:.7},behavior:'explore',pace:'conversational',creativity:'balanced',reasoning:'minimal'}};
function setup(){
  let now=1_800_000_000_000;
  const store=new Store();
  const backend={evaluate:async()=>({signals:structuredClone(signals),inputTokens:42,outputTokens:12,ms:150}),write:async()=>{now+=200;return 'A small synth idea.';}};
  const engine=new Engine(readConfig({}).config,store,backend,()=>now);
  const event:Event={id:'423456789012345678',channelId,userId:'user',displayName:'Person',text:'PRIVATE INPUT',direct:true,mentioned:true,at:now};
  const send=async(text:string):Promise<Turn>=>{now+=25;return {id:'sent',speakerId:'bot',speaker:'Audrey',text,isBot:true,at:now};};
  return {engine,backend,event,send,advance:(ms:number)=>{now+=ms;}};
}
function walk(value:unknown):{text:string;count:number}{
  if(!value||typeof value!=='object')return {text:'',count:0};
  const v=value as {type?:number;content?:string;components?:unknown[]};
  const kids=(v.components??[]).map(walk);
  return {text:[v.content??'',...kids.map(k=>k.text)].join('\n'),count:(v.type?1:0)+kids.reduce((n,k)=>n+k.count,0)};
}
test('all V2 views serialize within Discord limits and never expose conversation or memories',async()=>{
  const h=setup();await h.engine.submit(h.event,h.send);
  h.engine.store.user(channelId,'other').approved.push({id:'private',text:'PRIVATE MEMORY',createdAt:1});
  h.engine.receipts.get(channelId)![0]!.reply='PRIVATE REPLY';
  h.engine.receipts.set('other',[{id:'x',channelId:'other',action:'quiet',reason:'PRIVATE OTHER CHANNEL'}]);
  for(const view of VIEWS){
    const payload=renderDashboard(h.engine,new AutonomousClock(),{...panel,view},'google/gemini-3-flash');
    assert.equal(payload.flags,MessageFlags.IsComponentsV2);
    assert.deepEqual(payload.allowedMentions.parse,[]);
    const result=walk({components:payload.components.map(c=>c.toJSON())});
    assert.ok(result.count<=40,`${view}: ${result.count} components`);
    assert.ok(result.text.length<=4000,`${view}: ${result.text.length} characters`);
    assert.doesNotMatch(result.text,/PRIVATE/);
    assert.match(result.text,/EXPERIMENT CENTER/);
    if(view==='prompt')assert.match(result.text,/Writer was invoked/);
  }
});
test('mention trace distinguishes invitation from cooldown and records delivered timing',async()=>{
  const h=setup();const first=await h.engine.submit(h.event,h.send);
  assert.equal(first.trigger,'mention');assert.equal(first.action,'replied');
  assert.equal(first.timings?.writer,200);assert.equal(first.timings?.delivery,25);
  h.advance(1000);
  const second=await h.engine.submit({...h.event,direct:false,mentioned:false,id:'523456789012345678',at:h.engine.clock(),text:'Another question'},h.send);
  assert.equal(second.reason,'cooldown');assert.equal(second.writerStarted,undefined);
  assert.equal(decisionLabel(second),'SYSTEM BLOCK');assert.match(reasonText(second),/Direct requests bypass/);
  const payload=renderDashboard(h.engine,new AutonomousClock(),{...panel,view:'prompt'},'google/gemini-3-flash');
  assert.match(walk({components:payload.components.map(c=>c.toJSON())}).text,/Preview only/);
});
test('provider errors expose bounded failure metadata without raw errors',async()=>{
  const h=setup();h.backend.evaluate=async()=>{throw Object.assign(new Error('PRIVATE KEY AND PROMPT'),{statusCode:429});};
  const r=await h.engine.submit(h.event,h.send);
  assert.deepEqual(r.failure,{stage:'Jev',category:'rate_limit',status:429});
  assert.equal(decisionLabel(r),'SENT · STATE FALLBACK');assert.equal(h.engine.activity.size,0);
  const text=walk({components:renderDashboard(h.engine,new AutonomousClock(),panel,'google/gemini-3-flash').components.map(c=>c.toJSON())}).text;
  assert.match(text,/429/);assert.doesNotMatch(text,/PRIVATE KEY/);
});
test('active evaluation is visible and budgets show exhaustion before inference',async()=>{
  const h=setup();let release!:()=>void;
  h.backend.evaluate=async()=>{await new Promise<void>(r=>{release=r;});return {signals,inputTokens:1,outputTokens:1,ms:1};};
  const pending=h.engine.process(h.event,h.send);
  assert.equal(h.engine.diagnostics(channelId).activity?.stage,'Jev evaluating');
  assert.equal(h.engine.diagnostics(channelId).budgets.evaluations.used,1);
  release();await pending;assert.equal(h.engine.diagnostics(channelId).activity,undefined);
});
test('forget invalidates a selected event without retaining its expression',async()=>{
  const h=setup();await h.engine.submit(h.event,h.send);h.engine.forgetUser(channelId,'user');
  const payload=renderDashboard(h.engine,new AutonomousClock(),{...panel,view:'prompt',selected:h.event.id},'google/gemini-3-flash');
  assert.match(walk({components:payload.components.map(c=>c.toJSON())}).text,/No compiled expression/);
});
test('dashboard command reuses one message, restores registry, and rejects forged/cross-channel control',async()=>{
  const h=setup(),dir=mkdtempSync(join(tmpdir(),'audrey-dashboard-'));
  let sends=0,edits=0;
  const message={id:messageId,url:`https://discord.com/channels/${guildId}/${channelId}/${messageId}`,author:{id:'bot'},edit:async()=>{edits++;}};
  const channel={guildId,isSendable:()=>true,isDMBased:()=>false,messages:{fetch:async()=>message},send:async()=>{sends++;return message;}};
  const client={channels:{fetch:async()=>channel},user:{id:'bot'},isReady:()=>true} as unknown as Client;
  try {
    const file=join(dir,'panels.json'),dash=new Dashboard(client,h.engine,new AutonomousClock(),'google/gemini-3-flash',file,'owner',()=>true);
    const urls=await Promise.all([dash.open(channelId),dash.open(channelId)]);
    assert.equal(sends,1);assert.equal(edits,1);assert.equal(urls[0],urls[1]);
    assert.equal(new Dashboard(client,h.engine,new AutonomousClock(),'google/gemini-3-flash',file,'owner',()=>true).panels.size,1);
    let denied=0,deferred=0;
    const click={isButton:()=>true,isStringSelectMenu:()=>false,customId:'audreydash:pause',channelId,guildId,message:{id:messageId},
      user:{id:'outsider'},memberPermissions:{has:()=>false},reply:async()=>{denied++;},deferUpdate:async()=>{deferred++;}};
    assert.equal(await dash.interaction(click as unknown as Interaction),true);
    assert.equal(denied,1);assert.equal(deferred,0);assert.equal(h.engine.store.channel(channelId).paused,false);
    await dash.interaction({...click,user:{id:'owner'},message:{id:'forged'}} as unknown as Interaction);
    assert.equal(denied,2);assert.equal(h.engine.store.channel(channelId).paused,false);
    await dash.interaction({...click,user:{id:'owner'}} as unknown as Interaction);
    assert.equal(h.engine.store.channel(channelId).paused,true);assert.equal(deferred,1);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
