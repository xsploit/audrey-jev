import { execFile } from 'node:child_process';
import { speechFromNarration } from './escape-dialogue.js';
import { likelySecret, WindowBudget } from './policy.js';

export interface SpeechSettings { command:string;voice:string;pitch:string;rate:string;volume:string }
export interface SpeechRenderer { synthesize(text:string,signal?:AbortSignal,emotion?:string):Promise<Buffer> }
export class SpeechError extends Error {}

export function readSpeechSettings(env:NodeJS.ProcessEnv):SpeechSettings {
  const voice=env.EDGE_TTS_VOICE || 'en-US-AriaNeural';
  const pitch=env.EDGE_TTS_PITCH || '+26Hz';
  const rate=env.EDGE_TTS_RATE || '+3%';
  const volume=env.EDGE_TTS_VOLUME || '+0%';
  if (!/^[a-z]{2,3}-[A-Z]{2}-[A-Za-z0-9]+Neural$/.test(voice)) throw new Error('EDGE_TTS_VOICE must be a neural voice name, e.g. en-US-AriaNeural');
  if (!/^[+-]\d{1,3}Hz$/.test(pitch) || Number(pitch.slice(0,-2)) < -50 || Number(pitch.slice(0,-2))>100) throw new Error('EDGE_TTS_PITCH must be signed Hz from -50Hz to +100Hz');
  if (!/^[+-]\d{1,3}%$/.test(rate) || Number(rate.slice(0,-1)) < -50 || Number(rate.slice(0,-1))>100) throw new Error('EDGE_TTS_RATE must be a signed percentage from -50% to +100%');
  if (!/^[+-]\d{1,3}%$/.test(volume) || Number(volume.slice(0,-1)) < -50 || Number(volume.slice(0,-1))>50) throw new Error('EDGE_TTS_VOLUME must be a signed percentage from -50% to +50%');
  return {command:env.EDGE_TTS_COMMAND || 'edge-tts',voice,pitch,rate,volume};
}

export function spokenLines(narration:string):string {
  return speechFromNarration(narration);
}

export type SpeechRunner=(settings:SpeechSettings,text:string,signal?:AbortSignal)=>Promise<Buffer>;
const runEdge:SpeechRunner=(settings,text,signal)=>new Promise((resolve,reject)=>{
  // No shell and no speech in process arguments. Audio stays in memory; stdin carries the text.
  const child=execFile(settings.command,['--file','-','--voice',settings.voice,`--pitch=${settings.pitch}`,`--rate=${settings.rate}`,`--volume=${settings.volume}`],
    {encoding:'buffer',timeout:30_000,maxBuffer:4*1024*1024,killSignal:'SIGKILL',windowsHide:true,signal},(error,stdout)=>{
      if (error) {
        const missing='code' in error && error.code==='ENOENT';
        reject(new SpeechError(signal?.aborted ? 'Voice replay cancelled.' : missing ? 'Edge TTS is not installed on the bot host. Install it with uv tool install edge-tts.' : 'Voice is temporarily unavailable. Your text conversation is unaffected.'));
      } else resolve(stdout);
    });
  child.stdin?.on('error',()=>undefined); // A failed process may close stdin before the text is written.
  child.stdin?.end(text,'utf8');
});

export class EdgeSpeech implements SpeechRenderer {
  private busy=false;
  private budget=new WindowBudget(10,60_000);
  constructor(readonly settings:SpeechSettings,readonly run:SpeechRunner=runEdge,readonly clock=Date.now) {}
  async synthesize(text:string,signal?:AbortSignal):Promise<Buffer> {
    if (signal?.aborted) throw new SpeechError('Voice replay cancelled.');
    if (!text.trim() || text.length>1500 || likelySecret(text)) throw new SpeechError('No suitable spoken dialogue is available for this response.');
    if (this.busy) throw new SpeechError('A voice clip is still being prepared. Text conversation is unaffected.');
    if (!this.budget.take(this.clock())) throw new SpeechError('Voice replay limit reached. Try again in a minute.');
    this.busy=true;
    try {
      const audio=await this.run(this.settings,text,signal);
      if (signal?.aborted) throw new SpeechError('Voice replay cancelled.');
      const mp3=audio.subarray(0,3).toString()==='ID3' || audio[0]===0xff && ((audio[1] ?? 0)&0xe0)===0xe0;
      if (audio.length<100 || audio.length>4*1024*1024 || !mp3) throw new SpeechError('The speech service returned no usable audio. Your text conversation is unaffected.');
      return audio;
    } finally {this.busy=false;}
  }
}
