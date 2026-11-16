import {Waveform} from './waveform.js';

const $ = id => document.getElementById(id);
const fields = ['diagnostic','endpoint','model','temperature','maxTokens','silence','threshold','homeLanguage','rate','template','variables','omniSteps'];
for(const id of fields){
  const el=$(id);
  const key=['endpoint','model','diagnostic','silence','voice'].includes(id)?'duplex.'+id:id;
  const saved=localStorage.getItem(key);
  if(saved!==null){if(el.type==='checkbox')el.checked=saved==='true';else el.value=saved;}
  const show=()=>{if(el.type==='range')el.nextElementSibling.value=el.value;};
  el.addEventListener('input',()=>{localStorage.setItem(key,el.type==='checkbox'?el.checked:el.value);show();});show();
}
$('prefs').onclick=()=>$('settings').showModal();
$('prompt').onclick=()=>$('promptEditor').showModal();
const settings=()=>({
  diagnostic:$('diagnostic').checked, endpoint:$('endpoint').value, model:$('model').value,
  temperature:+$('temperature').value, maxTokens:+$('maxTokens').value, language:currentLanguage, homeLanguage:$('homeLanguage').value, device:'cpu', voice:'', voicePreferences:Object.fromEntries(Object.entries(voicePreferences).filter(([,id])=>!id.startsWith('omni-')||clonedVoices.some(voice=>voice.id===id))), rate:+$('rate').value, prompt:$('template').value,
  omniSteps:+$('omniSteps').value, variables:JSON.parse($('variables').value)
});
const turns=new Map(),colors={final:'#58a7bb',vad:'#9daa83',stt:'#5ec6e5',llm:'#e9b65c',tts:'#9ae565',play:'#b99dea'};
const voicesByLanguage={
  ru:[['ru_RU-dmitri-medium','Dmitri'],['ru_RU-irina-medium','Irina']],
  en:[['en_US-lessac-medium','Lessac']],de:[['de_DE-thorsten-medium','Thorsten']],
  fr:[['fr_FR-siwis-medium','Siwis']],tl:[['tl_PH-filipino-medium','Filipino Medium']]
};
let clonedVoices=[];
let voicePreferences={};
try{voicePreferences=JSON.parse(localStorage.getItem('voicePreferences')||'{}')??{};}catch{}
let currentLanguage=$('homeLanguage').value;
function renderVoices(){
  const selector=$('conversationVoice');
  selector.replaceChildren();
  const choices=[...voicesByLanguage[currentLanguage],...clonedVoices.map(v=>[v.id,v.name+' · OmniVoice'])];
  for(const [id,name] of choices){
    const option=document.createElement('option');option.value=id;option.textContent=name;selector.append(option);
  }
  const saved=voicePreferences[currentLanguage];
  if(choices.some(([id])=>id===saved))selector.value=saved;
  $('previewVoice').disabled=!selector.value.startsWith('omni-');
}
function chooseVoice(id){
  voicePreferences[currentLanguage]=id;
  localStorage.setItem('voicePreferences',JSON.stringify(voicePreferences));
  renderVoices();
}
$('conversationVoice').onchange=e=>chooseVoice(e.target.value);
renderVoices();
$('conversationLanguage').value=currentLanguage;
const voiceEditor=$('voiceEditor');
const voiceStatus=$('voiceStatus');
const voicePreview=$('voicePreview');
let previewUrl=null;
async function voiceRequest(path,payload){
  const response=await fetch('/api/voices'+path,payload===undefined?{}:{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)
  });
  if(!response.ok){
    const problem=await response.json().catch(()=>null);
    throw new Error(problem?.error||'OmniVoice: HTTP '+response.status);
  }
  return response;
}
async function loadVoices(){
  clonedVoices=await (await voiceRequest('')).json();
  applyLoadedVoices();
}
function applyLoadedVoices(){
  const preferred=clonedVoices.find(voice=>voice.preferredLanguage===currentLanguage);
  if(preferred){
    const key='preferredOmniVoice.'+currentLanguage;
    if(localStorage.getItem(key)!==preferred.id){
      localStorage.setItem(key,preferred.id);
      $('omniSteps').value='8';
      localStorage.setItem('omniSteps','8');
      chooseVoice(preferred.id);
      return;
    }
    if(!voicePreferences[currentLanguage]||
        (voicePreferences[currentLanguage].startsWith('omni-')&&
         !clonedVoices.some(voice=>voice.id===voicePreferences[currentLanguage]))){
      chooseVoice(preferred.id);
      return;
    }
  }
  renderVoices();
}
loadVoices().catch(()=>{});
$('voiceLab').onclick=async event=>{
  event.preventDefault();
  voiceEditor.showModal();
  voiceStatus.value='Проверяю OmniVoice…';
  try{await loadVoices();voiceStatus.value='';}
  catch(error){voiceStatus.value=error.message;}
};
$('closeVoiceEditor').onclick=()=>voiceEditor.close();
voiceEditor.addEventListener('close',()=>voicePreview.pause());
$('voiceForm').onsubmit=async event=>{
  event.preventDefault();
  const file=$('voiceReference').files[0];
  if(!file||file.size>10*1024*1024){voiceStatus.value='Выбери аудиофайл до 10 МиБ.';return;}
  $('saveVoice').disabled=true;
  voiceStatus.value='OmniVoice создаёт голос…';
  try{
    const request={name:$('voiceName').value,transcript:$('voiceTranscript').value,
      audio:encode(new Uint8Array(await file.arrayBuffer()))};
    const profile=await (await voiceRequest('',request)).json();
    clonedVoices.push(profile);
    chooseVoice(profile.id);
    event.target.reset();
    voiceStatus.value='Голос создан и выбран для текущего языка.';
  }catch(error){voiceStatus.value=error.message;}
  finally{$('saveVoice').disabled=false;}
};
$('previewVoice').onclick=async()=>{
  const voice=$('conversationVoice').value;
  const samples={ru:'Привет! Это проба нового голоса.',en:'Hello! This is a preview of the new voice.',
    de:'Hallo! Das ist eine Probe der neuen Stimme.',fr:'Bonjour ! Voici un aperçu de la nouvelle voix.',
    tl:'Kumusta! Ito ang pagsubok sa bagong boses.'};
  $('previewVoice').disabled=true;
  voiceStatus.value='Готовлю пробу…';
  try{
    const response=await voiceRequest('/preview',{voice,language:currentLanguage,steps:+$('omniSteps').value,text:samples[currentLanguage]});
    if(previewUrl)URL.revokeObjectURL(previewUrl);
    previewUrl=URL.createObjectURL(await response.blob());
    voicePreview.src=previewUrl;
    voicePreview.hidden=false;
    if(voiceEditor.open)await voicePreview.play().catch(()=>{});
    voiceStatus.value='';
  }catch(error){voiceStatus.value=error.message;}
  finally{renderVoices();}
};
const SEP=String.fromCharCode(30);
let socket,ready=false,active=null,microphone,ctx,node,source;
let micStream, micArmed=false, micStarting=false, speechTurn=null, preRoll=[], silence=0;
const awaitingFinal=new Map();
let follow=true,chosen,selected,clipUrl,nextPlay=0,liveSources=[];
const micWave = new Waveform($('micWave'));
const agentWave = new Waveform($('agentWave'));
const agentSamples = new Float32Array(1024);
let agentAnalyser, replaySource, waveFrame = 0;
const player = $('player');
function paintAgentWave(){
  waveFrame = 0;
  const replayingAgent = selected?.role === 'assistant' && !player.paused && !player.ended;
  if(ctx?.state !== 'running' || (!liveSources.length && !replayingAgent)){
    agentWave.draw();
    return;
  }
  agentAnalyser.getFloatTimeDomainData(agentSamples);
  agentWave.draw(agentSamples);
  requestAgentWave();
}
function requestAgentWave(){
  if(!waveFrame)waveFrame=requestAnimationFrame(paintAgentWave);
}
function routeReplay(){
  if(!replaySource)return;
  replaySource.disconnect();
  replaySource.connect(selected?.role==='assistant'?agentAnalyser:ctx.destination);
}
player.addEventListener('play',async()=>{
  await audioContext();
  if(!replaySource)replaySource=ctx.createMediaElementSource(player);
  routeReplay();
  requestAgentWave();
});
for(const event of ['pause','ended','emptied'])player.addEventListener(event,requestAgentWave);
const browserTrace = [];
let traceSession = null;
function trace(name, id = null, detail = {}) {
  browserTrace.push({time:new Date().toISOString(), browserMs:performance.now(), session:traceSession, id, name, detail});
  if (browserTrace.length > 1000) browserTrace.splice(0,100);
}
function traceMilestone(name,id=null,value=0) {
  trace(name,id,{value});
  sendHub({type:1,target:'ClientTrace',arguments:[name,id,performance.now(),value]});
}
$('exportTrace').onclick=()=>{
  const conversation=Array.from(turns.values(),t=>({
    id:t.id,mode:t.mode,language:t.language,replyLanguage:t.replyLanguage,
    user:t.user?.text,assistant:t.agent?.text,interrupted:!!t.interrupted,error:t.error,
    timings:Array.from(t.lanes.values())
  }));
  const data=JSON.stringify({version:1,session:traceSession,conversation,events:browserTrace},null,2);
  const url=URL.createObjectURL(new Blob([data],{type:'application/json'}));
  const link=document.createElement('a');
  link.href=url;
  link.download='voicelab-diagnostics-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json';
  link.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
};
window.addEventListener('error',e=>trace('browser.error',null,{message:e.message}));
window.addEventListener('unhandledrejection',e=>trace('browser.rejection',null,{message:String(e.reason)}));
const setStatus=s=>$('live').value=s;
function connect(){
  socket=new WebSocket((location.protocol==='https:'?'wss:':'ws:')+'//'+location.host+'/voice');
  socket.onopen=()=>socket.send(JSON.stringify({protocol:'json',version:1})+SEP);
  socket.onmessage=e=>{for(const line of e.data.split(SEP).filter(Boolean)){
    const msg=JSON.parse(line);
    if(!ready){ready=!msg.error;$('connection').textContent=ready?'LOCAL · ONLINE':'ОШИБКА';continue;}
    if(msg.type===1&&msg.target==='traceSession'){traceSession=msg.arguments[0];trace('connection.open');}
    if(msg.type===1&&msg.target==='event')receive(msg.arguments[0]);
    if(msg.type===1&&msg.target==='mic')receiveMic(msg.arguments[0]);
    if(msg.type===3&&msg.invocationId===micStream){
      releaseMic(false);if(msg.error)setStatus(msg.error);
    }
  }};
  socket.onclose=e=>{trace('connection.close',null,{code:e.code});ready=false;interrupt('disconnect');$('connection').textContent='OFFLINE';if(microphone)releaseMic(false);setTimeout(connect,1500);};
}
connect();
setInterval(()=>{if(ready)socket.send('{"type":6}'+SEP);},12000);
function invoke(id,text,pcm,mode,options){
  if(!ready)throw new Error('Сервер отключён');
  // Build context from the conversation displayed in the chat, including interrupted replies.
  const history=[];
  if(mode==='full'){
    for(const turn of turns.values()){
      if(turn.id===id||turn.mode!=='full'||turn.runOffset===undefined)continue;
      if(turn.user?.text.trim())history.push({role:'user',content:turn.user.text});
      if(turn.agent?.text.trim())history.push({role:'assistant',content:turn.agent.text});
    }
  }
  trace('request',id,{mode,language:options.language,model:options.model,historyCount:Math.min(16,history.length),textChars:text.length});
  socket.send(JSON.stringify({type:1,target:'Run',arguments:[id,text,pcm,mode,options,history.slice(-16)]})+SEP);
}
function message(role,turn,text){
  const button=document.createElement('button');
  const label=document.createElement('b');label.textContent=role==='user'?'ВЫ':'АГЕНТ';
  const body=document.createElement('div');body.textContent=text;
  button.className='msg';button.append(label,body);$('messages').append(button);
  const entry={role,turn,text,button,body};
  button.onclick=()=>select(entry);return entry;
}
function select(entry){
  selected?.button.setAttribute('aria-pressed','false');selected=entry;
  entry.button.setAttribute('aria-pressed','true');follow=false;chosen=entry.turn.id;
  $('selection').textContent=entry.role==='user'?'Исходная запись':'Синтезированный ответ';
  $('retry').textContent=entry.role==='user'?'Заново в STT':'Синтезировать повторно';
  updatePlayer();draw();
}
function updatePlayer(){
  if(clipUrl)URL.revokeObjectURL(clipUrl);
  player.pause();
  player.removeAttribute('src');clipUrl=null;
  routeReplay();
  const samples=selected?.role==='user'?selected.turn.pcm:selected?.turn.audio.flatMap(x=>x);
  $('retry').disabled=selected?.role==='assistant'?!selected?.text:!samples?.length;
  if(!samples?.length)player.load();
  if(samples?.length){clipUrl=URL.createObjectURL(wav(samples,selected.role==='user'?16000:selected.turn.sampleRate));$('player').src=clipUrl;}
}
function lane(t,name,part=0){
  const key=name+(part?' '+part:'');
  if(!t.lanes.has(key))t.lanes.set(key,{name,key});
  return t.lanes.get(key);
}
function run(text,pcm,mode='full',vad=0,speech=null){
  if(active&&!speech){setStatus('ДОЖДИСЬ ЗАВЕРШЕНИЯ РЕПЛИКИ');return;}
  try{
    const options=settings();
    if(mode==='stt'||mode==='tts')options.language=speech?.language??(mode==='tts'?selected?.turn?.replyLanguage:null)??selected?.turn?.language??currentLanguage;
    if(!ready)throw new Error('Сервер отключён');
    const id=speech?.id??crypto.randomUUID();
    const t=speech??{id,mode,pcm,audio:[],lanes:new Map(),start:performance.now(),vad,diagnostic:options.diagnostic,language:options.language};
    t.runOffset=performance.now()-t.start;
    turns.set(id,t);active=id;follow=true;chosen=id;
    if(vad)Object.assign(lane(t,'vad'),{start:0,end:vad});
    if(mode!=='tts'&&!t.user)t.user=message('user',t,text||(mode==='stt'?'Повторное распознавание…':'Распознавание…'));
    if(mode==='tts')t.agent=message('assistant',t,text);
    invoke(id,text,pcm?encode(pcm):null,mode,options);draw();
  }catch(e){active=null;setStatus(e.message);}
}
function receive(e){
  if(e.kind!=='audio'&&e.kind!=='delta')trace(e.stage+'.'+e.kind,e.id,
    {serverMs:e.ms,part:e.part,rate:e.rate,detail:e.kind==='error'||e.stage==='language'?e.data:undefined});
  const t=turns.get(e.id);if(!t||t.interrupted)return;
  if(e.stage==='language'&&e.kind==='switch'){
    t.replyLanguage=e.data;setLanguage(e.data);return;
  }
  const time=t.runOffset+e.ms;
  if(e.kind==='cancel'){t.interrupted=true;t.done=true;if(active===t.id)active=null;draw();return;}
  if(e.stage==='turn'){
    if(e.kind==='error'){t.error=e.data;setStatus(e.data);}
    if(e.kind==='end'){
      t.done=true;if(active===t.id)active=null;
      if(!t.error&&!speechTurn)setStatus(micArmed?'Микрофон активен':t.diagnostic?'ДИАГНОСТИКА · ГОТОВО':'ГОТОВО');
      if(selected?.turn===t)updatePlayer();
    }
  }else{
    const l=lane(t,e.stage,e.part);
    if(e.kind==='start')l.start=time;
    if(e.kind==='first'){l.first=time;l.source=e.data;}
    if(e.kind==='end'){l.end=time;if(e.stage==='stt'){t.user.text=e.data;t.user.body.textContent=e.data||'Речь не распознана';}}
    if(e.kind==='delta'){
      if(!t.agent)t.agent=message('assistant',t,'');
      t.agent.text+=e.data;t.agent.body.textContent=t.agent.text;
      $('messages').scrollTop=$('messages').scrollHeight;
    }
    if(e.kind==='audio')play(t,e.data,e.part,e.rate).catch(err=>setStatus(err.message));
  }
  draw();
}
async function play(t,data,part,rate){
  const raw=Uint8Array.from(atob(data),x=>x.charCodeAt(0));
  if(!rate||raw.length%2)throw new Error('Некорректный PCM');
  const pcm=new Int16Array(raw.buffer);
  t.sampleRate=rate;t.audio.push(pcm);
  if(!ctx||ctx.state!=='running')return;
  const buffer=ctx.createBuffer(1,pcm.length,rate);
  buffer.copyToChannel(Float32Array.from(pcm,x=>x/32768),0);
  const src=ctx.createBufferSource();src.buffer=buffer;src.connect(agentAnalyser);
  const when=nextPlay>ctx.currentTime?nextPlay:ctx.currentTime+.018;
  const start=performance.now()-t.start+(when-ctx.currentTime)*1000;
  const playback=lane(t,'play',part);
  if(playback.start===undefined)traceMilestone('play.first',t.id,Math.round(start));
  playback.start??=start;playback.end=start+buffer.duration*1000;
  src.start(when);nextPlay=when+buffer.duration;liveSources.push({src,t});requestAgentWave();
  src.onended=()=>{liveSources=liveSources.filter(x=>x.src!==src);};
}
let drawPending=false;
function draw(){
  if(drawPending)return;
  drawPending=true;
  requestAnimationFrame(()=>{drawPending=false;paint();});
}
function paint(){
  const timeline=$('timeline');timeline.replaceChildren();
  const all=Array.from(turns.values());
  if(!all.length)return;
  const origin=all[0].start-all[0].vad;
  const limit=Math.max(100,...all.map(item=>item.start-item.vad-origin+
    Math.max(0,...Array.from(item.lanes.values(),l=>l.end??l.first??l.start??0))));
  for(const [index,t] of Array.from(turns.values()).entries()){
    const button=document.createElement('button');button.className='turn';
    button.setAttribute('aria-pressed',String(chosen===t.id));
    const name=document.createElement('span');name.textContent=(index+1)+' · '+(t.user?.text||t.agent?.text||'Реплика').slice(0,68);
    const duration=document.createElement('span');duration.textContent=t.interrupted?'ПЕРЕБИТО':t.error?'ОШИБКА':t.done?Math.round(Math.max(0,...Array.from(t.lanes.values(),l=>l.end||0)))+' мс':'LIVE';
    const mini=document.createElement('i');mini.className='mini';
    const stages=Array.from(t.lanes.values()).filter(l=>l.end>l.start);
    for(const l of stages){
      const bit=document.createElement('span');
      bit.style.cssText='--c:'+colors[l.name]+';left:'+((t.start-t.vad-origin+l.start)/limit*100)+'%;width:'+((l.end-l.start)/limit*100)+'%';
      bit.title=l.key+' · '+Math.round(l.end-l.start)+' мс';mini.append(bit);
    }
    button.append(name,duration,mini);button.onclick=()=>{follow=false;chosen=t.id;draw();};timeline.append(button);
  }
  const t=turns.get(follow?active||chosen:chosen),wf=$('waterfall');wf.replaceChildren();
  if(!t)return;
  $('turnLabel').textContent=t.diagnostic?'ДИАГНОСТИКА':'ЛОКАЛЬНЫЙ LLM';
  const rows=Array.from(t.lanes.values()),elapsed=t.vad+performance.now()-t.start;
  const bound=Math.max(100,...rows.map(l=>l.end??(t.done?l.first??l.start:elapsed)));
  for(const l of rows){
    if(l.start===undefined)continue;
    const row=document.createElement('div');row.className='lane';
    const name=document.createElement('span');name.textContent=l.key.toUpperCase();
    const track=document.createElement('div');track.className='track';
    const end=l.end??(t.done?l.first??l.start:elapsed);
    const bar=document.createElement('i');bar.className='bar';bar.style.cssText='--c:'+colors[l.name]+';left:'+(l.start/bound*100)+'%;width:'+((end-l.start)/bound*100)+'%';track.append(bar);
    if(l.first!==undefined){const marker=document.createElement('i');marker.className='first';marker.style.left=(l.first/bound*100)+'%';track.append(marker);}
    const value=document.createElement('span');value.textContent=Math.round(end-l.start)+' мс'+(l.first===undefined?'':' / '+Math.round(l.first-l.start))+(l.source?' '+l.source:'');
    value.classList.toggle('over-budget',l.first-l.start>500&&['stt','llm','tts'].includes(l.name));
    value.title='Длительность / первый результат. Бюджет этапа 500 мс';row.append(name,track,value);wf.append(row);
  }
  const first=rows.find(l=>l.name==='play');
  const voiceLatency=first&&t.lastVoice!==undefined?Math.round(t.start+first.start-t.lastVoice):null;
  $('latency').classList.toggle('over-budget',voiceLatency>1500);
  $('latency').value=(voiceLatency!==null?'Голос → звук ≈ '+voiceLatency+' мс · цель 500 / лимит 1500 · ':'')+'Шкала 0–'+Math.ceil(bound)+' мс';
}
function encode(pcm){
  const bytes=new Uint8Array(pcm.buffer,pcm.byteOffset,pcm.byteLength);let s='';
  for(let i=0;i<bytes.length;i+=8192)s+=String.fromCharCode(...bytes.subarray(i,i+8192));
  return btoa(s);
}
function merged(parts){
  const out=new Int16Array(parts.reduce((n,p)=>n+p.length,0));let i=0;
  for(const p of parts){out.set(p,i);i+=p.length;}return out;
}
function wav(samples,rate){
  const lists=Array.isArray(samples)?samples:[samples],n=lists.reduce((x,p)=>x+p.length,0);
  const header=new DataView(new ArrayBuffer(44));
  for(const [at,label] of [[0,'RIFF'],[8,'WAVE'],[12,'fmt '],[36,'data']])
    [...label].forEach((x,i)=>header.setUint8(at+i,x.charCodeAt(0)));
  header.setUint32(4,36+n*2,true);header.setUint32(16,16,true);header.setUint16(20,1,true);header.setUint16(22,1,true);
  header.setUint32(24,rate,true);header.setUint32(28,rate*2,true);header.setUint16(32,2,true);header.setUint16(34,16,true);header.setUint32(40,n*2,true);
  return new Blob([header.buffer,...lists],{type:'audio/wav'});
}
async function audioContext(){
  if(!ctx){
    ctx=new AudioContext({sampleRate:16000});
    agentAnalyser=ctx.createAnalyser();
    agentAnalyser.fftSize=agentSamples.length;
    agentAnalyser.connect(ctx.destination);
  }
  await ctx.resume();
}
$('send').onsubmit=async e=>{e.preventDefault();const text=$('text').value.trim();if(!text||active)return;await audioContext();run(text,null);$('text').value='';};
$('retry').onclick=async()=>{const entry=selected;if(!entry)return;await audioContext();run(entry.text,entry.role==='user'?entry.turn.pcm:null,entry.role==='user'?'stt':'tts');};
function sendHub(message){if(ready)socket.send(JSON.stringify(message)+SEP);}
function micFrame(id,kind,pcm=null,language=null){
  sendHub({type:2,invocationId:micStream+'-frames',item:{id,kind,pcm:pcm?encode(pcm):null,language}});
}
function interrupt(reason='manual'){
  const responses=new Set(liveSources.map(x=>x.t.id));
  if(active)responses.add(active);
  for(const id of responses){
    const t=turns.get(id);
    if(t){
      t.interrupted=true;t.done=true;
      const at=performance.now()-t.start;
      for(const l of t.lanes.values()){
        if(l.name==='play'&&l.start>at){t.lanes.delete(l.key);continue;}
        l.end=Math.min(l.end??at,at);
      }
    }
    trace('interrupt.reason',id,{reason});
    traceMilestone('interrupt',id);
    sendHub({type:1,target:'Interrupt',arguments:[id]});
  }
  for(const {src} of liveSources){try{src.stop();}catch{}}
  liveSources=[];nextPlay=ctx?.currentTime??0;active=null;
  if(responses.size){if(selected)updatePlayer();draw();}
  return responses.size>0;
}
$('mic').onclick=async()=>{
  if(micStarting||microphone)return;
  if(!ready){setStatus('Сервер отключён');return;}
  micStarting=true;$('mic').disabled=true;
  try{
    await audioContext();
    await ctx.audioWorklet.addModule('capture.js');
    microphone=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true}});
    if(!ready)throw new Error('Сервер отключён');
    source=ctx.createMediaStreamSource(microphone);node=new AudioWorkletNode(ctx,'capture');
    source.connect(node);node.connect(ctx.destination);
    node.port.onmessage=e=>capture(e.data);
    micStream=crypto.randomUUID();
    sendHub({type:1,target:'Listen',invocationId:micStream,arguments:[],streamIds:[micStream+'-frames']});
    $('stop').disabled=false;setStatus('Прогрев потокового STT…');
  }catch(e){releaseMic();setStatus(e.message);}
  finally{micStarting=false;}
};
function capture(data){
  micWave.draw(data);
  if(!micArmed)return;
  const now=performance.now(),ms=data.length/ctx.sampleRate*1000;
  const rms=Math.sqrt(data.reduce((n,x)=>n+x*x,0)/data.length);
  const ratio=ctx.sampleRate/16000;
  const pcm=Int16Array.from({length:Math.round(data.length/ratio)},(_,i)=>Math.max(-32768,Math.min(32767,data[Math.floor(i*ratio)]*32768)));
  const voiced=rms>=+$('threshold').value;
  if(!speechTurn&&!voiced){
    preRoll.push(pcm);if(preRoll.length>4)preRoll.shift();return;
  }
  if(!speechTurn){
    const id=crypto.randomUUID();
    speechTurn={id,mode:'full',audio:[],lanes:new Map(),start:now,lastVoice:now,vad:0,parts:preRoll,diagnostic:$('diagnostic').checked,language:currentLanguage};
    turns.set(id,speechTurn);chosen=id;follow=true;
    lane(speechTurn,'stt').start=0;
    traceMilestone('mic.start',id,preRoll.length);
    micFrame(id,'start',null,currentLanguage);
    for(const part of preRoll)micFrame(id,'audio',part);
    preRoll=[];silence=0;
  }
  const t=speechTurn;
  if(voiced){t.lastVoice=now;silence=0;}else silence+=ms;
  t.parts.push(pcm);micFrame(t.id,'audio',pcm);
  if(silence>=Math.max(80,+$('silence').value)||t.parts.length>=1450){
    const end=now-t.start;
    Object.assign(lane(t,'vad'),{start:t.lastVoice-t.start,end});
    lane(t,'final').start=end;
    speechTurn=null;
    awaitingFinal.set(t.id,t);
    traceMilestone('mic.end',t.id,Math.round(silence));
    micFrame(t.id,'final');
  }
}
function receiveMic(event){
  trace('mic.'+event.kind,event.id,{chars:event.text?.length??0,
    detail:event.kind==='error'?event.text:undefined});
  if(event.kind==='ready'){prepareLanguage();return;}
  if(event.kind==='prepared'){
    if(event.id===preparingLanguage){preparingLanguage=null;micArmed=true;setStatus('Микрофон активен');}
    return;
  }
  if(event.kind==='error'){
    if(event.id===preparingLanguage){preparingLanguage=null;micArmed=false;}
    if(speechTurn?.id===event.id)speechTurn=null;
    awaitingFinal.delete(event.id);
    const failed=turns.get(event.id);if(failed){failed.error=event.text;failed.done=true;draw();}
    setStatus(event.text);return;
  }
  const t=turns.get(event.id);if(!t)return;
  const now=performance.now()-t.start;
  const text=event.text.trim();
  if(text){
    const stt=lane(t,'stt');stt.first??=now;
    if(!t.user)t.user=message('user',t,text);
    t.user.text=text;t.user.body.textContent=text;
  }
  if(event.kind==='partial'){
    const words=text.toLowerCase().match(/[\p{L}\p{N}]+/gu)??[];
    const previous=t.partialWords??[];
    if(words.length>=2&&previous.length>=2&&words[0]===previous[0]&&words[1]===previous[1]){
      if(interrupt('stable-partial'))setStatus('Перебивание · '+text);
    }
    t.partialWords=words;draw();return;
  }
  awaitingFinal.delete(t.id);
  lane(t,'stt').end=now;
  Object.assign(lane(t,'final'),{first:now,end:now});
  if(!text){t.done=true;delete t.parts;draw();return;}
  interrupt('final-stt');
  t.pcm=merged(t.parts);delete t.parts;
  run(text,null,'full',0,t);
}
let preparingLanguage=null;
function prepareLanguage(){
  if(!micStream||!ready)return;
  micArmed=false;
  preparingLanguage=crypto.randomUUID();
  micFrame(preparingLanguage,'prepare',null,currentLanguage);
  setStatus('Подготавливаю распознавание · '+currentLanguage.toUpperCase());
}
function discardCapture(){
  if(speechTurn){
    micFrame(speechTurn.id,'final');
    speechTurn.user?.button.remove();
    turns.delete(speechTurn.id);
    speechTurn=null;
  }
  for(const id of awaitingFinal.keys()){turns.get(id)?.user?.button.remove();turns.delete(id);}
  awaitingFinal.clear();preRoll=[];
}
function setLanguage(code){
  if(!Array.from($('conversationLanguage').options).some(option=>option.value===code))return;
  if(currentLanguage!==code){
    currentLanguage=code;
    traceMilestone('language.change');
    discardCapture();
    prepareLanguage();
  }
  $('conversationLanguage').value=code;
  applyLoadedVoices();
}
$('conversationLanguage').onchange=e=>{interrupt();setLanguage(e.target.value);};
$('home').onclick=()=>{interrupt();setLanguage($('homeLanguage').value);};
$('reset').onclick=()=>{
  traceMilestone('reset');
  interrupt('reset');discardCapture();turns.clear();
  chosen=undefined;selected=undefined;follow=true;
  $('messages').replaceChildren();$('timeline').replaceChildren();$('waterfall').replaceChildren();
  $('latency').value='';$('turnLabel').textContent='';
  $('selection').textContent='Выбери сообщение в чате';
  $('retry').textContent='Повторить';updatePlayer();
  setStatus(micArmed?'Микрофон активен':'Диалог сброшен');
  setLanguage($('homeLanguage').value);
};
function releaseMic(notify=true){
  if(micStream)trace('mic.release',null,{notify});
  if(notify&&micStream)sendHub({type:3,invocationId:micStream+'-frames'});
  micStream=null;preparingLanguage=null;micArmed=false;speechTurn=null;preRoll=[];awaitingFinal.clear();
  for(const t of turns.values())if(t.runOffset===undefined){t.done=true;}
  microphone?.getTracks().forEach(t=>t.stop());microphone=null;
  if(node)node.port.onmessage=null;node?.disconnect();source?.disconnect();
  micWave.draw();
  $('mic').disabled=false;$('stop').disabled=true;
}
$('stop').onclick=()=>{releaseMic();setStatus('Микрофон выключен');};

if($('lfLoad'))$('lfLoad').onclick=async()=>{
  try{
    const url='/prompts/'+encodeURIComponent($('lfName').value)+'?label='+encodeURIComponent($('lfLabel').value);
    const res=await fetch(url);
    if(!res.ok)throw new Error((await res.text()).slice(0,250));
    const item=await res.json();
    if(typeof item.prompt!=='string')throw new Error('Выбери промпт типа Text.');
    $('template').value=item.prompt;
    $('template').dispatchEvent(new Event('input'));
    $('lfStatus').value='Версия '+item.version;
  }catch(e){$('lfStatus').value=e.message;}
};
