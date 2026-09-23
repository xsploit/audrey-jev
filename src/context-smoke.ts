import { loadConfig } from './config.js';
import { createBackend } from './backend.js';
import { ConversationTracker } from './conversation.js';
import { replyDecision } from './policy.js';
import type { Event, EvaluationInput, Turn } from './types.js';
import { baseline } from './state.js';

// Explicitly synthetic model smoke test. No Discord client, sends, or real message fetches.
const settings=loadConfig();
if(!settings.apiKey || !settings.writerModel) throw new Error('Requires AI_GATEWAY_API_KEY and WRITER_MODEL in .env; this command makes paid model calls.');
const backend=createBackend(settings.apiKey,settings.writerModel);
const tracker=new ConversationTracker();
const now=Date.now();
const record=(event:Event,replyText?:string)=>{
  const selection=tracker.select(event,event.at);
  const turn:Turn={id:event.id,speakerId:event.userId,speaker:event.displayName,text:event.text,isBot:false,at:event.at};
  tracker.record(event.channelId,turn,selection.context,event.userId,event.at);
  if(replyText)tracker.record(event.channelId,{id:`bot-${event.id}`,speakerId:'audrey',speaker:'Audrey',text:replyText,isBot:true,at:event.at+1,replyTo:event.id},selection.context,event.userId,event.at+1);
};
record({id:'kai-root',userId:'kai',displayName:'Kai',channelId:'synthetic',text:'My synth sequence is set to 140 BPM.',direct:true,at:now-20_000},'Nice. How are you sequencing it?');
record({id:'nova-root',userId:'nova',displayName:'Nova',channelId:'synthetic',text:'My piano song is 90 BPM and in D minor.',direct:true,at:now-10_000},'What kind of arrangement are you trying?');
const cases:{name:string;event:Event;expected:string;check?:(text:string)=>boolean}[]=[
  {name:'separate-speaker-followup',event:{id:'check1',userId:'kai',displayName:'Kai',channelId:'synthetic',text:'Audrey, what tempo did I say my synth sequence is set to?',direct:true,at:now},expected:'140 BPM, not Nova’s 90 BPM',check:text=>/140/.test(text)&&!/90/.test(text)},
  {name:'explicit-other-speaker-reply',event:{id:'check2',userId:'kai',displayName:'Kai',channelId:'synthetic',text:'Audrey, what key did Nova say her song uses?',direct:true,at:now+1,replyTo:'nova-root',replyChainStatus:'complete',replyChain:[{id:'nova-root',channelId:'synthetic',speakerId:'nova',speaker:'Nova',text:'My piano song is 90 BPM and in D minor.',at:now-10_000,isBot:false}]},expected:'D minor',check:text=>/d minor/i.test(text)},
  {name:'missing-target',event:{id:'check3',userId:'kai',displayName:'Kai',channelId:'synthetic',text:'Audrey, can you explain that?',direct:true,at:now+2,replyTo:'deleted',replyChain:[],replyChainStatus:'missing'},expected:'Ask what “that” refers to; do not invent the missing message'},
  {name:'reply-to-nova-not-audrey',event:{id:'check4',userId:'kai',displayName:'Kai',channelId:'synthetic',text:'Why did you choose that key?',direct:false,at:now+3,replyTo:'nova-root',replyChainStatus:'complete',replyChain:[{id:'nova-root',channelId:'synthetic',speakerId:'nova',speaker:'Nova',text:'My song is in D minor.',at:now-10_000,isBot:false}]},expected:'Deterministic quiet: addressed to Nova, not Audrey'},
];
console.log('LIVE SYNTHETIC CONTEXT SMOKE — no Discord connection or sends; not a production benchmark.');
for(const item of cases) {
  const selection=tracker.select(item.event,item.event.at);
  const event={...item.event,addressedToOther:selection.context.addressedToOther};
  const input:EvaluationInput={botName:'Audrey',interests:'synthesizers, music',event,history:selection.history,context:selection.context,mood:{...baseline,updatedAt:now},memories:[]};
  try {
    const evaluation=await backend.evaluate(input);
    const decision=replyDecision(event,evaluation.signals,settings.config,false);
    // Writer smoke is explicit for direct requests, independent of the experimental answered threshold.
    const reply=item.event.direct ? await backend.write!(input,evaluation.signals,[]) : undefined;
    const check=item.check ? item.check(reply ?? '') : item.event.direct ? 'manual review' : decision==='addressed-to-someone-else';
    console.log(JSON.stringify({case:item.name,expected:item.expected,historyIds:selection.history.map(t=>t.id),source:selection.context.source,replyStatus:selection.context.replyStatus,jevMs:evaluation.ms,addressed:evaluation.signals.addressed,decision,reply,check}));
    if(check===false)process.exitCode=1;
  } catch {console.log(JSON.stringify({case:item.name,error:'Model smoke failed; no Discord effects'}));process.exitCode=1;}
}
