// Paid synthetic provider check. Never connects to Discord or touches saved state.
import { config } from 'dotenv';
import { createBackend } from './backend.js';
import { readConfig } from './config.js';
import { compileExpression, generationSettings } from './expression.js';
import type { EvaluationInput } from './types.js';
config({path:new URL('../.env',import.meta.url).pathname,quiet:true});
const settings=readConfig();
const backend=createBackend(settings.apiKey,settings.writerModel);
for(const [index,text] of ['The synth finally works! That bass is ridiculous haha.','The audio still crackles after hours of debugging. Can you help me narrow it down?'].entries()) {
  const at=Date.now();
  const input:EvaluationInput={botName:'Audrey',interests:'coding, synthesizers, music',
    event:{id:`synthetic-${index}`,channelId:'synthetic',userId:'synthetic-user',displayName:'Test musician',text,direct:true,at},
    history:[],memories:[],mood:{valence:index===0?.7:.35,arousal:.6,dominance:.5,updatedAt:at},
    drives:{curiosity:.8,socialBattery:index===0?.8:.3,tension:index===0?.1:.6,updatedAt:at}};
  try {
    const result=await backend.evaluate(input);
    const compiled=compileExpression(input,result.signals);
    const reply=await backend.write!(input,result.signals,[]);
    console.log(JSON.stringify({synthetic:true,model:settings.writerModel,ms:result.ms,active:compiled.active,
      behavior:compiled.behavior,pace:compiled.pace,settings:generationSettings(settings.writerModel,result.signals.expression),reply}));
  } catch(error) {
    console.error(JSON.stringify({synthetic:true,failed:true,error:error instanceof Error?error.name:'unknown'}));process.exitCode=1;
  }
}
