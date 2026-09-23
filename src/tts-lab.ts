import { createServer, type IncomingMessage } from 'node:http';
import { readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { config as loadEnv } from 'dotenv';
import { z } from 'zod';
import { EdgeSpeech, readSpeechSettings, SpeechError, type SpeechSettings } from './escape-speech.js';
import { WindowBudget } from './policy.js';
import { FISH_MODEL, FISH_REFERENCE, synthesizeFish } from './fish-speech.js';

const execute=promisify(execFile);
export const previewSchema=z.object({text:z.string().trim().min(1).max(1500),voice:z.string().max(100).default('en-US-AriaNeural'),
  pitch:z.number().int().min(-50).max(100).default(26),rate:z.number().int().min(-50).max(100).default(3),volume:z.number().int().min(-50).max(50).default(0),
  provider:z.enum(['edge','fish']).default('edge'),referenceId:z.string().regex(/^[a-f0-9]{32}$/i).default(FISH_REFERENCE)}).strict();
const signed=(n:number,unit:string)=>`${n>=0 ? '+' : ''}${n}${unit}`;
export function previewSettings(input:z.infer<typeof previewSchema>,base:SpeechSettings):SpeechSettings {
  return readSpeechSettings({EDGE_TTS_COMMAND:base.command,EDGE_TTS_VOICE:input.voice,
    EDGE_TTS_PITCH:signed(input.pitch,'Hz'),EDGE_TTS_RATE:signed(input.rate,'%'),EDGE_TTS_VOLUME:signed(input.volume,'%')});
}

async function body(req:IncomingMessage):Promise<unknown> {
  const parts:Buffer[]=[];let size=0;
  for await (const part of req) {size+=part.length;if(size>12_000)throw new Error('Body too large');parts.push(Buffer.from(part));}
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
}
export interface LabOptions {
  settings:SpeechSettings;
  reference?:{audio:Buffer;type:string};
  synthesize?:(settings:SpeechSettings,text:string,signal:AbortSignal)=>Promise<Buffer>;
  voices?:()=>Promise<{name:string;gender:string}[]>;
  fishApiKey?:string;
  fishRequest?:typeof fetch;
}
export function createTtsLab(options:LabOptions) {
  const token=randomBytes(24).toString('hex');const budget=new WindowBudget(20,60_000);let busy=false;
  let voices:Promise<{name:string;gender:string}[]>|undefined;
  const assets=new Map([
    ['/',{type:'text/html; charset=utf-8',data:readFileSync(new URL('./tts-lab/index.html',import.meta.url))}],
    ['/app.js',{type:'text/javascript; charset=utf-8',data:readFileSync(new URL('./tts-lab/app.js',import.meta.url))}],
    ['/style.css',{type:'text/css; charset=utf-8',data:readFileSync(new URL('./tts-lab/style.css',import.meta.url))}],
  ]);
  return createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; media-src 'self' blob:; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'");
    const json=(status:number,value:unknown)=>{if(!res.destroyed){res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));}};
    const host=req.headers.host ?? '';
    if (!/^(?:127\.0\.0\.1|localhost):\d+$/.test(host)) {json(403,{error:'Use the localhost URL printed by the tester.'});return;}
    if (req.headers.origin && req.headers.origin!==`http://${host}`) {json(403,{error:'Cross-origin requests are not allowed.'});return;}
    try {
      const path=new URL(req.url ?? '/',`http://${host}`).pathname;
      if(req.method==='GET' && assets.has(path)) {const asset=assets.get(path)!;res.writeHead(200,{'Content-Type':asset.type});res.end(asset.data);return;}
      if(req.method==='GET' && path==='/api/config') {
        const s=options.settings;
        json(200,{token,defaults:{voice:s.voice,pitch:parseInt(s.pitch),rate:parseInt(s.rate),volume:parseInt(s.volume),provider:'edge',referenceId:FISH_REFERENCE},reference:Boolean(options.reference),fishAvailable:Boolean(options.fishApiKey),fishModel:FISH_MODEL});return;
      }
      if(req.method==='GET' && path==='/reference' && options.reference) {
        const {audio,type}=options.reference;let start=0,end=audio.length-1;
        if(req.headers.range) {
          const match=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
          if(match && (match[1] || match[2])) {
            start=match[1] ? Number(match[1]) : Math.max(0,audio.length-Number(match[2]));
            end=match[1] && match[2] ? Math.min(Number(match[2]),end) : end;
          } else start=-1;
          if(!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start<0 || start>end) {res.writeHead(416,{'Content-Range':`bytes */${audio.length}`});res.end();return;}
          res.setHeader('Content-Range',`bytes ${start}-${end}/${audio.length}`);
        }
        res.writeHead(req.headers.range ? 206 : 200,{'Content-Type':type,'Content-Length':end-start+1,'Accept-Ranges':'bytes'});
        res.end(audio.subarray(start,end+1));return;
      }
      if(req.method==='GET' && path==='/api/voices') {
        voices ??= options.voices ? options.voices() : execute(options.settings.command,['--list-voices'],{timeout:15_000,maxBuffer:1024*1024}).then(({stdout})=>
          stdout.split('\n').map(line=>{const [name='',gender='']=line.trim().split(/\s+/);return {name,gender};})
            .filter(v=>/^[a-z]{2,3}-[A-Z]{2}-[A-Za-z0-9]+Neural$/.test(v.name)));
        try {json(200,{voices:await voices});} catch {voices=undefined;json(503,{error:'Voice list unavailable. You can still use the starter voices.'});}return;
      }
      if(req.method==='POST' && path==='/api/synthesize') {
        if(req.headers['x-voice-lab']!==token) {json(403,{error:'Refresh the tester and try again.'});return;}
        if(!req.headers['content-type']?.startsWith('application/json')) {json(415,{error:'JSON required.'});return;}
        let input:z.infer<typeof previewSchema>;let settings:SpeechSettings;
        try {input=previewSchema.parse(await body(req));settings=previewSettings(input,options.settings);}
        catch {json(400,{error:'Check the text and settings. Text must be 1–1,500 characters and sliders must stay within range.'});return;}
        if(input.provider==='fish' && !options.fishApiKey) {json(503,{error:'Set FISH_API_KEY on the server and restart the tester to enable Fish.'});return;}
        if(busy) {json(409,{error:'A take is already rendering. Wait a moment or cancel it.'});return;}
        if(!budget.take(Date.now())) {json(429,{error:'Twenty previews per minute. Give it a moment, then try again.'});return;}
        busy=true;const controller=new AbortController();
        res.on('close',()=>{if(!res.writableEnded)controller.abort();});
        try {
          const audio=await (input.provider==='fish' ? synthesizeFish(options.fishApiKey!,input.text,input.referenceId,controller.signal,options.fishRequest)
            : options.synthesize ? options.synthesize(settings,input.text,controller.signal) : new EdgeSpeech(settings).synthesize(input.text,controller.signal));
          if(!controller.signal.aborted) {res.writeHead(200,{'Content-Type':'audio/mpeg','Content-Length':audio.length});res.end(audio);}
        } catch(error) {if(!controller.signal.aborted)json(502,{error:error instanceof SpeechError ? error.message : 'Speech generation failed. Check that edge-tts is installed and online.'});}
        finally {busy=false;}
        return;
      }
      json(404,{error:'Not found'});
    } catch {json(500,{error:'The tester could not complete that request.'});}
  });
}

if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  loadEnv({quiet:true});
  loadEnv({path:resolve('data/voice-lab.env'),quiet:true});
  const port=Number(process.env.EDGE_TTS_LAB_PORT || 4174);
  if(!Number.isInteger(port) || port<1024 || port>65535)throw new Error('EDGE_TTS_LAB_PORT must be 1024–65535');
  let reference:LabOptions['reference'];
  if(process.env.EDGE_TTS_REFERENCE_FILE) {
    const types:Record<string,string>={'.wav':'audio/wav','.mp3':'audio/mpeg','.ogg':'audio/ogg','.m4a':'audio/mp4'};
    const type=types[extname(process.env.EDGE_TTS_REFERENCE_FILE).toLowerCase()];
    const audio=readFileSync(process.env.EDGE_TTS_REFERENCE_FILE);
    if(!type || audio.length>10*1024*1024)throw new Error('Reference must be WAV, MP3, OGG or M4A, at most 10 MB');
    reference={type,audio};
  }
  const server=createTtsLab({settings:readSpeechSettings(process.env),reference,fishApiKey:process.env.FISH_API_KEY});
  server.on('error',()=>{console.error('Voice tester could not start. The port may already be in use.');process.exitCode=1;});
  server.listen(port,'127.0.0.1',()=>console.log(`Audrey Voice Lab: http://127.0.0.1:${port} — preview only; Edge and ${FISH_MODEL} speech are generated online.`));
}
