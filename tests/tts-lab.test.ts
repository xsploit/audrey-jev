import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createTtsLab, type LabOptions } from '../src/tts-lab.js';
import { readSpeechSettings } from '../src/escape-speech.js';

const audio=Buffer.concat([Buffer.from('ID3'),Buffer.alloc(100)]);
const input={text:'Hello, Audrey.',voice:'en-US-AriaNeural',pitch:26,rate:3,volume:0};
async function harness(options:Partial<LabOptions>,run:(url:string,token:string)=>Promise<void>) {
  const server=createTtsLab({settings:readSpeechSettings({}),voices:async()=>[{name:'en-US-AriaNeural',gender:'Female'}],synthesize:async()=>audio,...options});
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const url=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {const config=await (await fetch(`${url}/api/config`)).json();await run(url,config.token);}
  finally {server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
}
function post(url:string,token:string,value:unknown,extra:RequestInit={}) {
  return fetch(`${url}/api/synthesize`,{method:'POST',headers:{'Content-Type':'application/json','X-Voice-Lab':token},body:JSON.stringify(value),...extra});
}

test('tester serves defaults, reference audio and voice catalogue without exposing executable paths',async()=>{
  await harness({reference:{audio:Buffer.from('reference'),type:'audio/wav'}},async(url)=>{
    const config=await (await fetch(`${url}/api/config`)).json();assert.equal(config.defaults.pitch,26);assert.equal(config.reference,true);assert.equal(config.defaults.command,undefined);
    const page=await (await fetch(url)).text();assert.match(page,/Generate &amp; listen|Generate & listen/);
    assert.equal(await (await fetch(`${url}/reference`)).text(),'reference');
    const range=await fetch(`${url}/reference`,{headers:{Range:'bytes=0-2'}});assert.equal(range.status,206);assert.equal(await range.text(),'ref');assert.equal(range.headers.get('content-range'),'bytes 0-2/9');
    assert.equal((await fetch(`${url}/reference`,{headers:{Range:'bytes=99-100'}})).status,416);
    const voices=await (await fetch(`${url}/api/voices`)).json();assert.equal(voices.voices[0].name,'en-US-AriaNeural');
    assert.equal((await fetch(`${url}/.env`)).status,404);
  });
});

test('tester sends validated tuning to the shared renderer and returns MP3 audio',async()=>{
  let received:unknown;
  await harness({synthesize:async(settings,text)=>{received={settings,text};return audio;}},async(url,token)=>{
    const result=await post(url,token,{...input,pitch:39,rate:-5,volume:7});
    assert.equal(result.status,200);assert.equal(result.headers.get('content-type'),'audio/mpeg');
    assert.deepEqual(Buffer.from(await result.arrayBuffer()),audio);
    assert.deepEqual(received,{settings:{command:'edge-tts',voice:'en-US-AriaNeural',pitch:'+39Hz',rate:'-5%',volume:'+7%'},text:'Hello, Audrey.'});
  });
});

test('invalid settings, executable injection and cross-origin synthesis are rejected before speech',async()=>{
  let calls=0;
  await harness({synthesize:async()=>{calls++;return audio;}},async(url,token)=>{
    assert.equal((await post(url,'wrong',input)).status,403);
    assert.equal((await post(url,token,{...input,pitch:101})).status,400);
    assert.equal((await post(url,token,{...input,command:'malicious'})).status,400);
    assert.equal((await post(url,token,{...input,text:' '.repeat(10)})).status,400);
    assert.equal((await post(url,token,input,{headers:{'Content-Type':'application/json','X-Voice-Lab':token,Origin:'https://example.com'}})).status,403);
    assert.equal(calls,0);
  });
});

test('only one take renders at a time and cancelling releases the slot',async()=>{
  let begun!:()=>void;const started=new Promise<void>(r=>{begun=r;});let calls=0;
  await harness({synthesize:async(_settings,_text,signal)=>{
    if(++calls>1)return audio;
    begun();return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true}));
  }},async(url,token)=>{
    const controller=new AbortController();const first=post(url,token,input,{signal:controller.signal});
    await started;assert.equal((await post(url,token,input)).status,409);
    controller.abort();await assert.rejects(first);
    // Give the local socket-close event time to cancel the child request.
    await new Promise(r=>setTimeout(r,30));
    assert.equal((await post(url,token,input)).status,200);
  });
});

test('Fish tester mode keeps credentials server-side and uses only the requested free model',async()=>{
  await harness({fishApiKey:'test-private-key',fishRequest:async(_url,options)=>{
    assert.equal(new Headers(options?.headers).get('model'),'s2.1-pro-free');
    return new Response(new Uint8Array(audio));
  }},async(url,token)=>{
    const config=await (await fetch(`${url}/api/config`)).json();assert.equal(config.fishAvailable,true);
    assert.equal(config.fishModel,'s2.1-pro-free');assert.ok(!JSON.stringify(config).includes('test-private-key'));
    const result=await post(url,token,{provider:'fish',text:'[excited] Hello!'});assert.equal(result.status,200);
    assert.deepEqual(Buffer.from(await result.arrayBuffer()),audio);
  });
  await harness({},async(url,token)=>{assert.equal((await post(url,token,{provider:'fish',text:'Hello'})).status,503);});
});
