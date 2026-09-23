import test from 'node:test';
import assert from 'node:assert/strict';
import { synthesizeFish, FishSpeech, FISH_MODEL, FISH_REFERENCE } from '../src/fish-speech.js';
import { readConfig } from '../src/config.js';

const audio=new Uint8Array(Buffer.concat([Buffer.from('ID3'),Buffer.alloc(200)]));
test('Fish sends the exact requested free model, reference and emotion-tagged text',async()=>{
  let calls=0;
  const request:typeof fetch=async(url,options)=>{
    calls++;assert.equal(url,'https://api.fish.audio/v1/tts');
    const headers=new Headers(options?.headers);
    assert.equal(headers.get('model'),'s2.1-pro-free');assert.equal(headers.get('Authorization'),'Bearer test-key');
    assert.deepEqual(JSON.parse(String(options?.body)),{text:'[excited] Hello!',reference_id:FISH_REFERENCE,format:'mp3'});
    return new Response(audio,{headers:{'Content-Type':'audio/mpeg'}});
  };
  assert.deepEqual(await synthesizeFish('test-key','[excited] Hello!',FISH_REFERENCE,undefined,request),Buffer.from(audio));assert.equal(calls,1);
});
test('Fish errors do not expose provider bodies or credentials and do not fall back to another model',async()=>{
  let calls=0;const request:typeof fetch=async()=>{calls++;return new Response('test-key and private provider details',{status:403});};
  await assert.rejects(synthesizeFish('test-key','Hello',FISH_REFERENCE,undefined,request),error=>{
    assert.ok(error instanceof Error);assert.match(error.message,/s2\.1-pro-free.*403/);assert.doesNotMatch(error.message,/test-key|private provider/);return true;
  });assert.equal(calls,1);assert.equal(FISH_MODEL,'s2.1-pro-free');
});
test('Fish validates the voice reference and rejects oversized or non-audio responses',async()=>{
  const request:typeof fetch=async()=>new Response('not audio');
  await assert.rejects(synthesizeFish('test-key','Hello','invalid',undefined,request),/reference ID/);
  await assert.rejects(synthesizeFish('test-key','Hello',FISH_REFERENCE,undefined,request),/usable MP3/);
  const large:typeof fetch=async()=>new Response(new Uint8Array(4*1024*1024+1));
  await assert.rejects(synthesizeFish('test-key','Hello',FISH_REFERENCE,undefined,large),/size limit/);
});

test('escape Fish renderer uses its configured reference, maps emotion to delivery and respects cancellation',async()=>{
  const bodies:{text:string;reference_id:string}[]=[];
  const speech=new FishSpeech('test-key',FISH_REFERENCE,async(_url,options)=>{bodies.push(JSON.parse(String(options?.body)));return new Response(audio);});
  await speech.synthesize('You remembered my name.',undefined,'flustered');
  assert.deepEqual(bodies[0],{text:'[playful] You remembered my name.',reference_id:FISH_REFERENCE,format:'mp3'});
  await assert.rejects(speech.synthesize('Hello',AbortSignal.abort()),/cancelled/);assert.equal(bodies.length,1);
  const config=readConfig({ESCAPE_TTS_PROVIDER:'fish',FISH_API_KEY:'test-key'});
  assert.equal(config.escapeSpeechProvider,'fish');assert.equal(config.fishReference,FISH_REFERENCE);
  assert.throws(()=>new FishSpeech(''));assert.throws(()=>readConfig({ESCAPE_TTS_PROVIDER:'unknown'}));
});

test('escape Fish renderer bounds concurrency and recovers its slot after provider errors',async()=>{
  let release!:(response:Response)=>void;
  const speech=new FishSpeech('test-key',FISH_REFERENCE,async()=>new Promise(r=>{release=r;}));
  const first=speech.synthesize('Hello');await assert.rejects(speech.synthesize('Again'),/still preparing/);
  release(new Response('Unavailable',{status:503}));await assert.rejects(first,/503/);
  const second=speech.synthesize('Again');release(new Response(audio));assert.deepEqual(await second,Buffer.from(audio));
});
