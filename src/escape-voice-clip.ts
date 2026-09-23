import { execFile } from 'node:child_process';
import { MessageFlags } from 'discord.js';
import { SpeechError } from './escape-speech.js';

export interface VoiceClip { audio:Buffer;duration:number;waveform:string }
export type VoiceEncoder=(audio:Buffer,signal?:AbortSignal)=>Promise<VoiceClip>;

function transcode(input:Buffer,args:string[],signal?:AbortSignal):Promise<Buffer> {
  return new Promise((resolve,reject)=>{
    const child=execFile('ffmpeg',['-hide_banner','-loglevel','error',...args],
      {encoding:'buffer',timeout:15_000,maxBuffer:8*1024*1024,killSignal:'SIGKILL',windowsHide:true,signal},(error,stdout)=>{
        if (error) reject(new SpeechError(signal?.aborted ? 'Voice cancelled.' : 'Voice encoding failed. Check that ffmpeg with libopus is installed.'));
        else resolve(stdout);
      });
    child.stdin?.on('error',()=>undefined);child.stdin?.end(input);
  });
}

export function voiceMetadata(pcm:Buffer):{duration:number;waveform:string} {
  const samples=pcm.length/2;const duration=samples/16000;
  if (!Number.isInteger(samples) || duration<=0 || duration>180) throw new SpeechError('Invalid voice duration.');
  const points=Math.min(256,Math.ceil(duration*10));
  const rms=Array.from({length:points},(_,i)=>{
    const start=Math.floor(i*samples/points),end=Math.floor((i+1)*samples/points);let power=0;
    for(let j=start;j<end;j++) power+=(pcm.readInt16LE(j*2)/32768)**2;
    return Math.sqrt(power/Math.max(1,end-start));
  });
  const peak=Math.max(...rms,0.000001);
  const waveform=Buffer.from(rms.map(value=>Math.round(255*value/peak))).toString('base64');
  return {duration:Math.round(duration*1000)/1000,waveform};
}

export const encodeVoiceClip:VoiceEncoder=async(audio,signal)=>{
  const pcm=await transcode(audio,['-i','pipe:0','-vn','-ac','1','-ar','16000','-f','s16le','pipe:1'],signal);
  const metadata=voiceMetadata(pcm);
  // The 16k PCM above is only for waveform measurement. Encode from the original 24k Edge
  // source, preserving its bandwidth; 128k VBR/complexity 10 minimizes further lossy degradation.
  const ogg=await transcode(audio,['-i','pipe:0','-vn','-ar','48000','-ac','1','-c:a','libopus','-b:a','128k','-vbr','on','-compression_level','10','-application','audio','-f','ogg','pipe:1'],signal);
  if (ogg.subarray(0,4).toString()!=='OggS' || ogg.length>4*1024*1024) throw new SpeechError('Invalid voice clip.');
  return {audio:ogg,...metadata};
};

// Discord forbids content/embeds on native voice messages. Reference the separate text reply instead.
// Explicit audio MIME is important: Discord ignores voice metadata for non-audio uploads.
export function voiceMessageRequest(clip:VoiceClip,replyTo:string) {
  return {
    body:{flags:MessageFlags.IsVoiceMessage,
      attachments:[{id:'0',filename:'voice-message.ogg',duration_secs:clip.duration,waveform:clip.waveform}],
      message_reference:{message_id:replyTo,fail_if_not_exists:false},allowed_mentions:{parse:[],replied_user:false}},
    files:[{name:'voice-message.ogg',data:clip.audio,contentType:'audio/ogg'}],
  };
}
