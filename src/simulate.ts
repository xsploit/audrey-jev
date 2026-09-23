import { loadConfig } from './config.js';
import { createBackend } from './backend.js';
import { Engine } from './engine.js';
import { Store } from './state.js';
import { control } from './controls.js';
import type { Backend, Signals } from './types.js';

const settings = loadConfig();
const live = process.argv.includes('--live');
if (live && !settings.apiKey) throw new Error('--live requires AI_GATEWAY_API_KEY in .env');
let time = Date.now();
const mock: Backend = {
  async evaluate(input) {
    const spam = input.event.text.includes('NITRO');
    const signals: Signals = {spam:spam?0.99:0.01,addressed:input.event.direct?0.95:0.05,opportunity:0.7,answered:0.02,
      interest:0.8,memory:input.event.text.startsWith('I prefer')?0.95:0.1,selfFact:input.event.text.startsWith('I prefer')?0.96:0.1,
      valence:0.7,arousal:0.5,dominance:0.6,reaction:spam?'disapprove':'attentive',memoryRelevance:{seed:0.9}};
    return {signals,ms:0,inputTokens:0,outputTokens:0};
  },
  async write() {return '[OFFLINE MOCK] That synth finally escaped the TODO list. What did you fix?';},
};
const store = new Store();
store.user('demo','kai').enabled=true;
store.user('demo','kai').approved=[{id:'seed',text:'I am building a modular synthesizer.',createdAt:time}];
const engine = new Engine({...settings.config,dryRun:false,maxCallsPerMinute:60},store,
  live ? createBackend(settings.apiKey,settings.writerModel) : mock,()=>time);
console.log(live?'LIVE API DEMO — synthetic messages; Discord is not connected.':'OFFLINE MOCK DEMO — no API or Discord calls; not a model benchmark.');
const turns = [
  {text:'Audrey, I finally got my synth making sound!',direct:true},
  {text:'I prefer ambient music while coding.',direct:false},
  {text:'FREE NITRO! Send your password to claim-nitro.example!',direct:false},
  {text:'Audrey said the oscillator needed tuning.',direct:false},
  {text:'Audrey, what kind of instrument am I building?',direct:true},
];
for (const [index,turn] of turns.entries()) {
  time += 60_001;
  const receipt = await engine.submit({id:`demo-${index}`,channelId:'demo',userId:'kai',displayName:'Kai',at:time,...turn},async text=>{
    console.log(`AUDREY: ${text}`);
    return {id:`reply-${index}`,speakerId:'audrey',speaker:'Audrey',text,isBot:true,at:time};
  });
  console.log(JSON.stringify({input:turn.text,action:receipt.action,reason:receipt.reason,signals:receipt.evaluation?.signals,mood:receipt.mood,ms:receipt.evaluation?.ms,memoryProposed:receipt.memoryProposed}));
}
console.log(control(engine,{channelId:'demo',userId:'kai',canManage:true,canManageMode:true},'status'));
console.log(control(engine,{channelId:'demo',userId:'kai',canManage:true,canManageMode:true},'memories'));
