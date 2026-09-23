import { loadConfig } from './config.js';
import { createEscapeBackend } from './escape-backend.js';
import { EscapeEngine } from './escape-engine.js';
import { EscapeStore, newSession } from './escape-state.js';
import { NPC_NAME, DIALOGUE_VERSION } from './escape-scenario.js';

// Synthetic prompts only. No Discord connection, live session read, or state-file writes.
if (!process.argv.includes('--live')) {
  console.log('Use npm run escape:demo -- --live for a paid synthetic Jev/Gemini dialogue check. No Discord messages are sent.');
} else {
  const config=loadConfig();
  if (!config.apiKey || !config.writerModel) throw new Error('Configure the Gateway key and writer model first.');
  const store=new EscapeStore();store.put(newSession('demo-thread','demo-guild','demo-parent','demo-player'));
  let clock=Date.now();
  const backend=createEscapeBackend(config.apiKey,config.writerModel);
  if(process.argv.includes('--inspect-drafts')) {
    const write=backend.write.bind(backend);
    backend.write=async(...args)=>{try{return await write(...args);}catch(error){
      const diagnostic=error as {name?:string;draft?:string;checks?:unknown};
      if(diagnostic.name==='UngroundedSpeechError')console.log(JSON.stringify({syntheticRejectedDraft:diagnostic.draft,checks:diagnostic.checks}));
      throw error;
    }};
  }
  const game=new EscapeEngine(store,backend,()=>true,()=>clock);
  const opening=await game.opening(store.get('demo-thread')!);
  opening.history=[{id:'demo-opening',speakerId:'escape-eddie',speaker:NPC_NAME,text:opening.lastNarration,isBot:true,at:clock,styleVersion:DIALOGUE_VERSION}];
  store.put(opening);console.log(`\nGENERATED OPENING:\n${opening.lastNarration}`);
  const prompts=process.argv.includes('--combat') ? ['You are a pathetic, controlling bitch.','I don’t love you. Nobody could love someone as pathetic as you.','You’re boring and stupid. I was only pretending to like you.','Shut up. I hate you and I am going to leave you.','You are worthless to me. Stop talking.','You mean nothing to me.'] : process.argv.includes('--mechanics') ? ['i reach for thee phone and manage to call 911','heart rate starts dropping','you cant feel a pulse because my heart stops','911 open the door','police open the door help she drugged me','i get up and run out the door to safety','I take the apartment key while it is unguarded.','I unlock the door with the key.','I open the door.','I step through the doorway.'] : ['no who are you where im i','what i dont know you','who are you, you’re damn sexy','so what shall we do','I look out the window. Why is the city burning?','Why did you bring me here?'];
  for (const [i,text] of (process.argv.includes('--short') ? prompts.slice(0,4) : prompts).entries()) {
    console.log(`\nPLAYER: ${text}`);
    clock+=60_001;
    try {
      const s=await game.turn('demo-thread','demo-player',`demo-${i}`,text);
      console.log(`${NPC_NAME.toUpperCase()}: ${s.lastNarration}`);
      console.log(JSON.stringify({turn:s.turn,action:s.lastAction,emotion:s.emotion,clues:s.clues,ending:s.ending,physical:s.physical}));
      if(s.ending)break;
    } catch(error) {console.log(error instanceof Error ? error.message : 'Smoke turn failed');process.exitCode=1;break;}
  }
}
