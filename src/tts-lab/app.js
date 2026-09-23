const $=id=>document.getElementById(id);
const samples={reference:"Don't say that. That makes me embarrassed!",warm:"You're awake. I was starting to think you were avoiding me. Do you remember who I am?",tease:"Audrey. And you really shouldn't say things like that if you want me to behave myself.",quiet:"Stay a little longer. Just until the song ends. You used to like this part."};
let config,controller,sequence=0,currentId=null,referenceUrl=null,provider='edge';
let voices=[...$('voice').options].map(o=>({name:o.value,gender:'Female'}));
let takes=[];
const signed=(n,unit='')=>`${n>=0?'+':''}${n}${unit}`;
const status=(text,error=false)=>{$('status').textContent=text;$('status').classList.toggle('error',error);};
function settings(){return {provider,referenceId:$('fish-reference').value.trim(),voice:$('voice').value,pitch:Number($('pitch').value),rate:Number($('rate').value),volume:Number($('volume').value)};}
function availability(){
  $('generate').disabled=!config||Boolean(controller)||(provider==='fish'&&!config.fishAvailable);
  $('fish-status').textContent=config?.fishAvailable?'API key configured on the server.':'Set FISH_API_KEY on the server, then restart the tester.';
}
function setProvider(value){
  provider=value==='fish'?'fish':'edge';$('edge-settings').hidden=provider!=='edge';$('fish-settings').hidden=provider!=='fish';$('fish-tags').hidden=provider!=='fish';
  document.querySelectorAll('[data-provider]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.provider===provider)));
  $('copy').textContent=provider==='fish'?'Copy Fish request ↗':'Copy settings for Audrey ↗';
  availability();remember();
}
function remember(){try{localStorage.setItem('audrey-voice-lab',JSON.stringify({...settings(),text:$('text').value}));}catch{}}
function paintPresets(){document.querySelectorAll('[data-pitch]').forEach(b=>b.classList.toggle('active',Number(b.dataset.pitch)===Number($('pitch').value)));}
function apply(s){
  if(![...$('voice').options].some(o=>o.value===s.voice))$('voice').add(new Option(s.voice,s.voice));
  $('voice').value=s.voice;
  if(typeof s.referenceId==='string')$('fish-reference').value=s.referenceId;
  for(const key of ['pitch','rate','volume']){const slider=$(key),n=Number(s[key]);const value=Number.isFinite(n)?Math.max(Number(slider.min),Math.min(Number(slider.max),Math.round(n))):0;slider.value=value;$(`${key}-value`).value=value;}
  setProvider(s.provider);paintPresets();remember();
}
document.querySelectorAll('[data-provider]').forEach(button=>button.addEventListener('click',()=>{setProvider(button.dataset.provider);status(provider==='fish'?'Fish S2.1 Free selected. Add emotion tags or generate a take.':'Edge TTS selected. Adjust the pitch and speed.');}));
$('fish-reference').addEventListener('input',remember);
document.querySelectorAll('[data-tag]').forEach(button=>button.addEventListener('click',()=>{const field=$('text'),tag=button.dataset.tag+' ';if(field.value.length+tag.length<=1500)field.setRangeText(tag,field.selectionStart,field.selectionEnd,'end');field.focus();updateText();}));
$('fish-example').addEventListener('click',()=>{$('text').value='[excited] Hello! Welcome to Fish Audio. [laughing] This is my first AI-generated voice.';updateText();});
for(const key of ['pitch','rate','volume']){
  $(key).addEventListener('input',()=>{$(`${key}-value`).value=$(key).value;paintPresets();remember();});
  $(`${key}-value`).addEventListener('change',()=>{const n=Number($(`${key}-value`).value);$(key).value=Math.max(Number($(key).min),Math.min(Number($(key).max),Number.isFinite(n)?Math.round(n):0));$(`${key}-value`).value=$(key).value;paintPresets();remember();});
}
document.querySelectorAll('[data-pitch]').forEach(button=>button.addEventListener('click',()=>apply({...settings(),pitch:Number(button.dataset.pitch)})));
document.querySelectorAll('[data-sample]').forEach(button=>button.addEventListener('click',()=>{$('text').value=samples[button.dataset.sample];updateText();}));
function updateText(){$('count').textContent=`${$('text').value.length} / 1500`;remember();}
$('text').addEventListener('input',updateText);$('voice').addEventListener('change',remember);
$('reset').addEventListener('click',()=>{apply(config.defaults);status('Tuning reset to the starting preset.');});
function filterVoices(){
  const selected=$('voice').value,query=$('voice-filter').value.toLowerCase();
  const matches=voices.filter(v=>(!$('english').checked||v.name.startsWith('en-'))&&v.name.toLowerCase().includes(query));
  $('voice').replaceChildren();
  if(!matches.some(v=>v.name===selected))$('voice').add(new Option(`${selected} · current`,selected));
  for(const v of matches)$('voice').add(new Option(`${v.name.replace(/^[a-z]+-[A-Z]+-/,'').replace(/Neural$/,'')} · ${v.name.split('-').slice(0,2).join('-')} · ${v.gender}`,v.name));
  $('voice').value=selected;$('voice-status').textContent=`${matches.length} matching voices`;
}
$('english').addEventListener('change',filterVoices);$('voice-filter').addEventListener('input',filterVoices);
function pauseAudio(){document.querySelectorAll('audio').forEach(a=>a.pause());}
document.querySelectorAll('audio').forEach(audio=>audio.addEventListener('play',()=>document.querySelectorAll('audio').forEach(a=>{if(a!==audio)a.pause();})));
function selectTake(take,play=false){
  pauseAudio();currentId=take.id;$('empty-player').hidden=true;$('current').hidden=false;
  $('current-label').textContent=`TAKE ${String(take.id).padStart(2,'0')} / ${take.provider==='fish'?'Fish · '+config.fishModel:take.voice}`;
  $('source-quality').textContent=take.provider==='fish'?'FISH S2.1 FREE · MP3':'EDGE ORIGINAL · MP3';
  $('current-meta').textContent=take.provider==='fish'?`Reference ${take.referenceId}`:`${signed(take.pitch,' Hz')} pitch · ${signed(take.rate,'%')} speed · ${signed(take.volume,'%')} volume`;
  $('player').src=take.url;$('download').href=take.url;$('download').download=`audrey-${take.id}-pitch${signed(take.pitch)}.mp3`;
  renderTakes();
  if(play)$('player').play().catch(()=>status('Take ready. Press play to listen.'));
}
function renderTakes(){
  $('takes').replaceChildren();
  if(!takes.length){const empty=document.createElement('p');empty.className='empty-takes';empty.textContent='Your last six takes will appear here, each with its own settings.';$('takes').append(empty);return;}
  for(const take of takes){
    const card=document.createElement('div');card.className=`take${take.id===currentId?' current':''}`;
    const top=document.createElement('div');top.className='take-top';const title=document.createElement('strong');title.textContent=`Take ${String(take.id).padStart(2,'0')}`;const voice=document.createElement('span');voice.textContent=take.provider==='fish'?'Fish S2.1 Free':take.voice.replace(/^[a-z]+-[A-Z]+-/,'').replace(/Neural$/,'');top.append(title,voice);
    const meta=document.createElement('p');meta.className='take-meta';meta.textContent=take.provider==='fish'?`Reference ${take.referenceId.slice(0,12)}…`:`${signed(take.pitch,' Hz')} / ${signed(take.rate,'%')} / ${signed(take.volume,'%')}`;
    const text=document.createElement('p');text.className='take-text';text.textContent=take.text;text.title=take.text;
    const actions=document.createElement('div');actions.className='take-actions';
    for(const [label,fn,cls] of [['▶ Play',()=>selectTake(take,true),''],['Download',()=>{const a=document.createElement('a');a.href=take.url;a.download=`audrey-take-${take.id}.mp3`;a.click();},''],['Use settings',()=>{apply(take);$('text').value=take.text;updateText();status(`Loaded Take ${take.id} settings. Adjust and generate to compare.`);},'load']]){const button=document.createElement('button');button.type='button';button.textContent=label;button.className=cls;button.addEventListener('click',fn);actions.append(button);}
    card.append(top,meta,text,actions);$('takes').append(card);
  }
}
$('generate').addEventListener('click',async()=>{
  const text=$('text').value.trim();if(!text){status('Give her a line to say first.',true);$('text').focus();return;}
  const input={...settings(),text};controller=new AbortController();$('generate').disabled=true;$('generate').textContent='Rendering…';$('cancel').hidden=false;
  status(`Generating your take with ${input.provider==='fish'?config.fishModel:'Edge TTS'}…`);const started=performance.now();
  try{
    const response=await fetch('/api/synthesize',{method:'POST',headers:{'Content-Type':'application/json','X-Voice-Lab':config.token},body:JSON.stringify(input),signal:controller.signal});
    if(!response.ok){const data=await response.json();throw new Error(data.error||'Generation failed.');}
    const blob=await response.blob();const take={...input,id:++sequence,url:URL.createObjectURL(blob)};takes.unshift(take);
    if(takes.length>6){const old=takes.pop();URL.revokeObjectURL(old.url);}
    status(`Take ${take.id} ready in ${((performance.now()-started)/1000).toFixed(1)}s. Change a setting to compare another take.`);selectTake(take,$('autoplay').checked);
  }catch(error){status(error.name==='AbortError'?'Generation cancelled.':error.message,error.name!=='AbortError');}
  finally{controller=null;availability();$('generate').textContent='▶ Generate & listen';$('cancel').hidden=true;}
});
$('cancel').addEventListener('click',()=>controller?.abort());
$('clear').addEventListener('click',()=>{pauseAudio();$('player').removeAttribute('src');$('player').load();takes.forEach(t=>URL.revokeObjectURL(t.url));takes=[];currentId=null;$('current').hidden=true;$('empty-player').hidden=false;renderTakes();});
$('copy').addEventListener('click',async()=>{
  const s=settings();
  const body=JSON.stringify({text:$('text').value,reference_id:s.referenceId,format:'mp3'}).replaceAll("'","'\\''");
  const text=s.provider==='fish'?`curl -X POST https://api.fish.audio/v1/tts \\\n  -H "Authorization: Bearer $FISH_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -H "model: ${config.fishModel}" \\\n  -d '${body}' --output welcome.mp3`:`EDGE_TTS_VOICE=${s.voice}\nEDGE_TTS_PITCH=${signed(s.pitch,'Hz')}\nEDGE_TTS_RATE=${signed(s.rate,'%')}\nEDGE_TTS_VOLUME=${signed(s.volume,'%')}`;
  try{await navigator.clipboard.writeText(text);$('copy-status').textContent=s.provider==='fish'?'Copied the request. It uses your server’s FISH_API_KEY variable.':'Copied! Paste into .env and restart Audrey to apply.';$('config-export').hidden=true;}
  catch{$('config-export').hidden=false;$('config-export').value=text;$('config-export').select();$('copy-status').textContent=s.provider==='fish'?'Copy the request below; it does not contain your API key.':'Copy the settings below into .env, then restart Audrey.';}
});
$('reference-file').addEventListener('change',()=>{
  const file=$('reference-file').files[0];if(!file)return;
  if(file.size>10*1024*1024){status('Choose a reference smaller than 10 MB.',true);return;}
  if(referenceUrl)URL.revokeObjectURL(referenceUrl);referenceUrl=URL.createObjectURL(file);$('reference-player').src=referenceUrl;$('reference-player').hidden=false;$('reference-label').textContent=file.name;
});
$('text').addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key==='Enter'){e.preventDefault();if(!$('generate').disabled)$('generate').click();}});
async function boot(){
  try{
    const response=await fetch('/api/config');if(!response.ok)throw new Error('Tester unavailable. Reload the page.');config=await response.json();
    let saved;try{saved=JSON.parse(localStorage.getItem('audrey-voice-lab')||'null');}catch{}
    const requestedProvider=new URLSearchParams(location.search).get('provider');
    const requestedReference=new URLSearchParams(location.search).get('reference');
    apply({...config.defaults,...(saved&&typeof saved.voice==='string'?saved:{}),...(['edge','fish'].includes(requestedProvider)?{provider:requestedProvider}:{}),...(/^[a-f0-9]{32}$/i.test(requestedReference||'')?{referenceId:requestedReference}:{})});
    if(typeof saved?.text==='string')$('text').value=saved.text.slice(0,1500);updateText();
    if(config.reference){$('reference-player').src='/reference';$('reference-player').hidden=false;$('reference-label').textContent='Eddie · your reference recording';}
    availability();status('Ready. Generate a take, or press Ctrl + Enter.');
    try{const response=await fetch('/api/voices');const data=await response.json();if(!response.ok)throw new Error(data.error);voices=data.voices;filterVoices();}catch{$('voice-status').textContent='Starter voices available. Full catalogue could not load.';}
  }catch(error){status(error.message,true);}
}
boot();
