import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Client, type Interaction } from 'discord.js';
import { EscapeStore, newSession } from '../src/escape-state.js';
import { EscapeEngine, appraisalSchema, legalActions, type EscapeBackend } from '../src/escape-engine.js';
import { EscapeDiscord, sceneText } from '../src/escape-discord.js';
import { writerContext } from '../src/escape-dialogue.js';
import { WORLD, OPENING, TITLE, NPC_NAME, FAVORITE_FOODS, SCENARIO_VERSION, clueRecords } from '../src/escape-scenario.js';

const banned=/After the Sirens|six weeks|synthesizer|producer|Tomas|red thread|black fragment|pumping station|flare pistol/i;
const signals={spam:0,addressed:1,opportunity:1,answered:0,interest:0.5,memory:0,selfFact:0,valence:0.5,arousal:0.5,dominance:0.5,reaction:'attentive' as const,memoryRelevance:{}};
const neutral=()=>appraisalSchema.parse({intent:'talk',topic:'none',cooperation:0,contradiction:0,plan:0,coverStory:0,danger:0,calming:0});

test('the current scenario contains the researched apartment premise and no removed protagonist history',()=>{
  const s=newSession('t','g','p','u',1);
  assert.equal(NPC_NAME,'Eddie');assert.match(TITLE,/Catgirl/);assert.equal(s.loreVersion,SCENARIO_VERSION);
  assert.match(OPENING,/unfamiliar living room/);assert.match(OPENING,/pink-haired catgirl/);
  assert.match(WORLD,/apartment 201, second floor/);assert.match(WORLD,/Bureau of Apocalypse Observation/);
  assert.match(WORLD,/retracts the apocalypse/);assert.match(WORLD,/surveillance monitors/);assert.match(WORLD,/knife/);
  assert.doesNotMatch(WORLD,banned);assert.doesNotMatch(OPENING,banned);assert.doesNotMatch(JSON.stringify(writerContext(s)),banned);
  assert.deepEqual(s.clues,[]);assert.equal(s.playerRecognition,'unknown');
});

test('the exact two first-contact messages do not create a relationship clue or punish non-recognition',async()=>{
  let now=1_800_000_000_000;const store=new EscapeStore();store.put(newSession('t','g','p','u',now));
  const backend:EscapeBackend={
    assess:async()=>({signals,appraisal:{...neutral(),focus:'identity',recognition:'denied',social:'reject',contradiction:1}}),
    choose:async()=> 'answer',write:async(_s,text)=>({speech:`I’m Eddie. You said: ${text}`}),
  };
  const engine=new EscapeEngine(store,backend,()=>true,()=>now,()=>undefined);
  for(const [i,text] of ['no who are you where im i','what i dont know you'].entries()) {
    now+=60_001;const s=await engine.turn('t','u',`m${i}`,text);
    assert.equal(s.playerRecognition,'denied');assert.equal(s.hurt,0);assert.equal(s.trust,0.4);assert.deepEqual(s.clues,[]);
    assert.match(s.lastNarration,/Eddie/);assert.doesNotMatch(s.lastNarration,banned);assert.doesNotMatch(sceneText(s),/shared past|promised/);
  }
});

test('even high trust and pressure do not turn an identity question into a biography or confession',()=>{
  const s=newSession('t','g','p','u',1);s.trust=1;
  const a={...neutral(),focus:'identity' as const,recognition:'denied' as const,pressure:1};
  assert.deepEqual(legalActions(s,a),['answer']);
});

test('new journal records distinguish evidence from her claims and filter obsolete clues',()=>{
  const entries=clueRecords(['connection','surgery','window','kidnapping','favorite_food'],'ramen');
  assert.deepEqual(entries.map(e=>e.id),['window','kidnapping','favorite_food']);
  assert.equal(entries[1]?.kind,'Her admission');assert.match(entries[2]!.text,/ramen/);
  assert.doesNotMatch(JSON.stringify(entries),banned);
});

test('the per-session favourite food remains stable through persistence',()=>{
  const dir=mkdtempSync(join(tmpdir(),'apartment-lore-'));
  try {const file=join(dir,'state.json');const store=new EscapeStore(file);const s=newSession('t','g','p','u',1);store.put(s);
    assert.ok(FAVORITE_FOODS.includes(s.favoriteFood));assert.equal(new EscapeStore(file).get('t')?.favoriteFood,s.favoriteFood);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('legacy attempts cannot feed their invented history into the new models',async()=>{
  const store=new EscapeStore();const s=newSession('t','g','p','u',1);s.loreVersion=2;s.clues=['connection'];s.lastAction='reminisce';
  s.history=[{id:'old',speakerId:'bot',speaker:'Audrey',text:'We spent six weeks making After the Sirens.',isBot:true,at:1,styleVersion:3}];store.put(s);
  let calls=0;const unavailable=async()=>{calls++;throw new Error('Must not call');};
  const engine=new EscapeEngine(store,{assess:unavailable,choose:unavailable,write:unavailable},()=>true);
  await assert.rejects(engine.turn('t','u','new','I don’t know you.'),/replaced scenario/);assert.equal(calls,0);
  assert.doesNotMatch(sceneText(store.get('t')!),banned);assert.equal(store.get('t')?.history.length,1);
});

test('the old journal is not rendered as new canonical lore',async()=>{
  const store=new EscapeStore();const s=newSession('t','g','p','u',1);s.loreVersion=2;s.clues=['connection'];s.panelId='panel';store.put(s);
  const unused=async()=>{throw new Error('not used');};const engine=new EscapeEngine(store,{assess:unused,choose:unused,write:unused},()=>true);
  const adapter=new EscapeDiscord({} as Client,store,engine);const replies:string[]=[];
  await adapter.interaction({isChatInputCommand:()=>false,isButton:()=>true,isStringSelectMenu:()=>false,customId:'escape:t:0:journal',guildId:'g',channelId:'t',user:{id:'u'},message:{id:'panel'},deferred:true,
    deferReply:async()=>undefined,editReply:async(p:{content:string})=>{replies.push(p.content);}} as unknown as Interaction);
  assert.match(replies[0]!,/replaced scenario/);assert.doesNotMatch(replies[0]!,banned);
});
