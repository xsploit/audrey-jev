import { SpeechError, type SpeechRenderer } from './escape-speech.js';
import { likelySecret, WindowBudget } from './policy.js';

export const FISH_MODEL='s2.1-pro-free';
export const FISH_REFERENCE='ee4867b6908d41e58ee7736ce4874622';
export class FishSpeech implements SpeechRenderer {
  private busy=false;
  private budget=new WindowBudget(10,60_000);
  constructor(private readonly key:string,readonly referenceId=FISH_REFERENCE,readonly request:typeof fetch=fetch) {
    if(!key)throw new SpeechError('FISH_API_KEY is required when ESCAPE_TTS_PROVIDER=fish.');
    if(!/^[a-f0-9]{32}$/i.test(referenceId))throw new SpeechError('FISH_REFERENCE_ID must be a 32-character reference ID.');
  }
  async synthesize(text:string,signal?:AbortSignal,emotion?:string):Promise<Buffer> {
    if(signal?.aborted)throw new SpeechError('Fish voice cancelled.');
    if(this.busy)throw new SpeechError('Fish is still preparing a voice clip.');
    if(!this.budget.take(Date.now()))throw new SpeechError('Fish voice limit reached.');
    this.busy=true;
    try {
      const tags:Record<string,string>={affectionate:'[warm]',flustered:'[playful]',hurt:'[sad]',afraid:'[low voice]',softening:'[softly]',angry:'[angry]'};
      const tag=emotion ? tags[emotion] : undefined;
      return await synthesizeFish(this.key,tag?`${tag} ${text}`:text,this.referenceId,signal,this.request);
    } finally {this.busy=false;}
  }
}
export async function synthesizeFish(key:string,text:string,referenceId:string,signal?:AbortSignal,request:typeof fetch=fetch):Promise<Buffer> {
  if(!key)throw new SpeechError('Fish API key is not configured on the server.');
  if(!text.trim() || text.length>1500 || likelySecret(text) || !/^[a-f0-9]{32}$/i.test(referenceId))throw new SpeechError('Check the Fish reference ID and speech text.');
  try {
    const response=await request('https://api.fish.audio/v1/tts',{
      method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json',model:FISH_MODEL},
      body:JSON.stringify({text,reference_id:referenceId,format:'mp3'}),
      signal:AbortSignal.any([AbortSignal.timeout(45_000),...(signal?[signal]:[])]),
    });
    if(!response.ok) {await response.body?.cancel();throw new SpeechError(`Fish ${FISH_MODEL} returned HTTP ${response.status}. Check model access and the reference voice.`);}
    const reader=response.body?.getReader();if(!reader)throw new SpeechError('Fish returned no audio.');
    const chunks:Buffer[]=[];let size=0;
    try {
      while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>4*1024*1024){await reader.cancel();throw new SpeechError('Fish audio exceeded the preview size limit.');}chunks.push(Buffer.from(value));}
    } finally {reader.releaseLock();}
    const audio=Buffer.concat(chunks);
    if(audio.length<100 || !(audio.subarray(0,3).toString()==='ID3' || audio[0]===0xff && ((audio[1]??0)&0xe0)===0xe0))throw new SpeechError('Fish returned no usable MP3 audio.');
    return audio;
  } catch(error) {
    if(error instanceof SpeechError)throw error;
    throw new SpeechError(signal?.aborted ? 'Fish preview cancelled.' : 'Fish speech request failed or timed out. Try again shortly.');
  }
}
