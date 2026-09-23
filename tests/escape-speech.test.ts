import test from 'node:test';
import assert from 'node:assert/strict';
import { type Client, type Interaction, type Message, MessageFlags, ChannelType } from 'discord.js';
import { execFileSync, spawnSync } from 'node:child_process';
import { EdgeSpeech, readSpeechSettings, spokenLines, SpeechError, type SpeechRenderer } from '../src/escape-speech.js';
import { readConfig } from '../src/config.js';
import { EscapeStore, newSession } from '../src/escape-state.js';
import { EscapeEngine, type EscapeBackend } from '../src/escape-engine.js';
import { EscapeDiscord, scenePayload } from '../src/escape-discord.js';
import { encodeVoiceClip, voiceMetadata, voiceMessageRequest } from '../src/escape-voice-clip.js';

const mp3=()=>Buffer.concat([Buffer.from('ID3'),Buffer.alloc(200)]);
test('voice defaults to pitch-raised Aria with validated tuning and an off switch',()=>{
  assert.deepEqual(readSpeechSettings({}),{command:'edge-tts',voice:'en-US-AriaNeural',pitch:'+26Hz',rate:'+3%',volume:'+0%'});
  assert.equal(readConfig({ESCAPE_TTS_ENABLED:'false'}).escapeSpeech,undefined);
  assert.throws(()=>readSpeechSettings({EDGE_TTS_PITCH:'+999Hz'}));
  assert.throws(()=>readSpeechSettings({EDGE_TTS_RATE:'fast'}));
  assert.throws(()=>readSpeechSettings({EDGE_TTS_VOLUME:'+100%'}));
  assert.throws(()=>readSpeechSettings({EDGE_TTS_VOICE:'Aria; something else'}));
});

test('speech extracts spoken lines without gestures, repeated footers or journal facts',()=>{
  assert.equal(spokenLines('*She reads a note marked “Do not say this”.* “Hello.” She smiles. "Stay a moment."\n\n**Scene record**\n"The door is locked."'),'Hello. Stay a moment.');
  assert.equal(spokenLines('Audrey stands by the door. The game is over.'),'');
  assert.equal(spokenLines('“You’re awake.”\n\n“Do you remember me?”'),'You’re awake. Do you remember me?');
});

test('speech rejects invalid input before running the CLI and rejects non-audio output',async()=>{
  let calls=0;const speech=new EdgeSpeech(readSpeechSettings({}),async()=>{calls++;return Buffer.from('server error');});
  await assert.rejects(speech.synthesize(''),/No suitable/);
  await assert.rejects(speech.synthesize('vck_'+'x'.repeat(40)),/No suitable/);
  await assert.rejects(speech.synthesize('x'.repeat(1501)),/No suitable/);assert.equal(calls,0);
  await assert.rejects(speech.synthesize('Hello'),/no usable audio/);assert.equal(calls,1);
});

test('speech bounds concurrency and releases the slot after failure',async()=>{
  let release!:(value:Buffer)=>void;
  const speech=new EdgeSpeech(readSpeechSettings({}),async()=>new Promise<Buffer>(r=>{release=r;}));
  const first=speech.synthesize('Hello');
  await assert.rejects(speech.synthesize('Again'),/still being prepared/);
  release(mp3());assert.deepEqual(await first,mp3());
  const next=speech.synthesize('Again');release(mp3());await next;
  const failed=new EdgeSpeech(readSpeechSettings({}),async()=>{throw new SpeechError('Unavailable');});
  await assert.rejects(failed.synthesize('First'),/Unavailable/);
  await assert.rejects(failed.synthesize('Second'),/Unavailable/);
});

test('speech respects cancellation and rate limits',async()=>{
  let calls=0;const speech=new EdgeSpeech(readSpeechSettings({}),async()=>{calls++;return mp3();},()=>100);
  const cancelled=AbortSignal.abort();await assert.rejects(speech.synthesize('Hello',cancelled),/cancelled/);assert.equal(calls,0);
  for(let i=0;i<10;i++)await speech.synthesize('Hello');
  await assert.rejects(speech.synthesize('One more'),/limit reached/);assert.equal(calls,10);
});

function adapterHarness(speech:SpeechRenderer) {
  const store=new EscapeStore();const s=newSession('thread','guild','parent','owner');s.panelId='panel';s.lastNarration='*The apartment is quiet.*';store.put(s);
  const backend:EscapeBackend={
    assess:async()=>({signals:{spam:0,addressed:1,opportunity:1,answered:0,interest:0.5,memory:0,selfFact:0,valence:0.6,arousal:0.4,dominance:0.5,reaction:'attentive',memoryRelevance:{}},
      appraisal:{intent:'talk',topic:'none',cooperation:0,contradiction:0,plan:0,coverStory:0,danger:0,calming:0,social:'neutral',focus:'none',recognition:'unspecified',pressure:0,attempts:[],distraction:0}}),
    choose:async()=> 'answer',write:async s=> ({speech:s.turn===1?'Hello. Stay a moment.':`I heard your next question, turn ${s.turn}.`}),
  };
  const engine=new EscapeEngine(store,backend,()=>true,Date.now,()=>undefined);
  const replies:Record<string,unknown>[]=[];
  const clips:unknown[]=[];const textReplies:Record<string,unknown>[]=[];let serial=0;
  const thread={id:'thread',guildId:'guild',type:ChannelType.PrivateThread,isThread:()=>true,archived:false,
    sendTyping:async()=>undefined,messages:{fetch:async()=>({flags:{has:()=>true},edit:async()=>undefined})},
    send:async(payload:Record<string,unknown>)=>{textReplies.push(payload);return {id:`text-${textReplies.length}`};},
  };
  const client={channels:{fetch:async()=>thread},rest:{post:async(_route:string,payload:unknown)=>{clips.push(payload);return {id:'voice'};}}} as unknown as Client;
  const adapter=new EscapeDiscord(client,store,engine,true,speech,async()=>({audio:Buffer.from('OggS test'),duration:1,waveform:'AQID'}));
  const play=(userId='owner')=>adapter.message({channel:thread,channelId:'thread',guildId:'guild',author:{id:userId},id:`player-${++serial}`,content:'Hello'} as unknown as Message);
  const click=(action:string,userId='owner',revision=store.get('thread')?.revision ?? 0)=>adapter.interaction({
    isChatInputCommand:()=>false,isButton:()=>true,isStringSelectMenu:()=>false,
    customId:`escape:thread:${revision}:${action}`,guildId:'guild',channelId:'thread',user:{id:userId},message:{id:'panel'},
    deferred:true,deferReply:async(opts:{flags:number})=>assert.equal(opts.flags,MessageFlags.Ephemeral),
    editReply:async(opts:Record<string,unknown>)=>{replies.push(opts);},
  } as unknown as Interaction);
  return {store,adapter,engine,replies,clips,textReplies,click,play};
}

test('a normal player turn automatically sends a native voice reply; spectators do not generate speech',async()=>{
  const texts:string[]=[];
  const h=adapterHarness({synthesize:async text=>{texts.push(text);return mp3();}});
  await h.play('intruder');assert.equal(texts.length,0);
  await h.play();await new Promise(r=>setImmediate(r));assert.deepEqual(texts,['Hello. Stay a moment.']);
  assert.equal(h.textReplies[0]?.content,'“Hello. Stay a moment.”');assert.equal(h.clips.length,1);
  const request=h.clips[0] as ReturnType<typeof voiceMessageRequest>;
  assert.equal(request.body.flags,MessageFlags.IsVoiceMessage);assert.equal(request.body.message_reference.message_id,'text-1');
  assert.equal(request.files[0]?.contentType,'audio/ogg');assert.equal(h.store.get('thread')?.turn,1);
  assert.doesNotMatch(JSON.stringify(scenePayload(h.store.get('thread')!)),/Listen/);
});

test('ending an attempt cancels an in-flight voice replay and prevents attachment delivery',async()=>{
  let signal:AbortSignal|undefined;let release!:(audio:Buffer)=>void;
  const h=adapterHarness({synthesize:async(_text,s)=>{signal=s;return new Promise(r=>{release=r;});}});
  await h.play();await new Promise(r=>setImmediate(r));
  await h.click('end');assert.equal(signal?.aborted,true);
  release(mp3());await new Promise(r=>setImmediate(r));
  assert.equal(h.clips.length,0);assert.equal(h.store.get('thread')?.ending,'ended');
});

test('forgetting during synthesis blocks later audio and voice failures leave game state intact',async()=>{
  const h=adapterHarness({synthesize:async()=>{h.store.forget('thread');return mp3();}});
  await h.play();await new Promise(r=>setImmediate(r));assert.equal(h.clips.length,0);assert.equal(h.store.get('thread'),undefined);
  const failing=adapterHarness({synthesize:async()=>{throw new SpeechError('Voice unavailable');}});
  await failing.play();await new Promise(r=>setImmediate(r));
  assert.equal(failing.store.get('thread')?.turn,1);assert.equal(failing.textReplies.length,1);assert.equal(failing.clips.length,0);
});

test('new text turns remain responsive while old speech is pending and discard the cancelled clip',async()=>{
  let release!:(audio:Buffer)=>void;let firstSignal:AbortSignal|undefined;let calls=0;
  const h=adapterHarness({synthesize:async(_text,signal)=>{if(++calls===1){firstSignal=signal;return new Promise(r=>{release=r;});}return mp3();}});
  await h.play();await h.play();await new Promise(r=>setImmediate(r));
  assert.equal(h.store.get('thread')?.turn,2);assert.equal(firstSignal?.aborted,true);assert.equal(h.clips.length,1);
  release(mp3());await new Promise(r=>setImmediate(r));assert.equal(h.clips.length,1);
});

test('voice metadata is measured from PCM, bounded to 256 real waveform samples, and sent without text',()=>{
  const pcm=Buffer.alloc(32000);for(let i=8000;i<16000;i++)pcm.writeInt16LE(Math.round(16000*Math.sin(i/8)),i*2);
  const metadata=voiceMetadata(pcm);assert.equal(metadata.duration,1);
  const waveform=Buffer.from(metadata.waveform,'base64');assert.equal(waveform.length,10);assert.equal(waveform[0],0);assert.ok(waveform[9]!>0);
  assert.equal(Buffer.from(voiceMetadata(Buffer.alloc(32_000*30)).waveform,'base64').length,256);
  assert.throws(()=>voiceMetadata(Buffer.alloc(0)));assert.throws(()=>voiceMetadata(Buffer.alloc(3)));
  const request=voiceMessageRequest({audio:Buffer.from('OggS'),...metadata},'text-123');
  assert.equal(request.body.attachments[0]?.duration_secs,1);assert.equal('content' in request.body,false);assert.equal('embeds' in request.body,false);
});

test('real encoder produces mono 48kHz Opus in Ogg with duration and waveform',{skip:spawnSync('ffmpeg',['-version']).status!==0},async()=>{
  const samples=16000;const wav=Buffer.alloc(44+samples*2);
  wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);
  wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(16000,24);wav.writeUInt32LE(32000,28);
  wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(samples*2,40);
  for(let i=0;i<samples;i++)wav.writeInt16LE(Math.round(16000*Math.sin(2*Math.PI*220*i/16000)),44+i*2);
  const clip=await encodeVoiceClip(wav);assert.equal(clip.duration,1);assert.equal(clip.audio.subarray(0,4).toString(),'OggS');
  assert.equal(Buffer.from(clip.waveform,'base64').length,10);
  const result=JSON.parse(execFileSync('ffprobe',['-v','error','-show_entries','stream=codec_name,sample_rate,channels','-of','json','pipe:0'],{input:clip.audio,encoding:'utf8'}));
  assert.equal(result.streams[0].codec_name,'opus');assert.equal(result.streams[0].sample_rate,'48000');assert.equal(result.streams[0].channels,1);
});
