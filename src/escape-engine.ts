import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { EvaluationInput, Memory, Signals } from './types.js';
import { nudgeMood } from './state.js';
import { nudgeDrives, spendSocialBattery } from './drives.js';
import { likelySecret, WindowBudget } from './policy.js';
import { EscapeStore, type EscapeSession, actionSchema } from './escape-state.js';
import { ENDINGS, WORLD, OPENING, SCENARIO_VERSION, DIALOGUE_VERSION, NPC_NAME, type Clue, type EscapeAction } from './escape-scenario.js';
import { recentSpeech, renderSpeech, speechFingerprint, speechSchema, type SpeechReply, type WriterHints } from './escape-dialogue.js';
import { EscapeModelError, failureInfo } from './escape-diagnostics.js';
import { attemptSchema, beginPhysicalTurn, isDistracted, physicalSnapshot, resolvePhysical, type Attempt } from './escape-physical.js';

const unit=z.number().finite().min(0).max(1);
export const appraisalSchema=z.object({
  intent:z.enum(['talk','inspect','leave_alone','leave_together','force_exit','attack']),
  topic:z.enum(['none','window','photos','parrot','computer','key','door']),
  cooperation:unit, contradiction:unit, plan:unit, coverStory:unit, danger:unit, calming:unit,
  social:z.enum(['neutral','flirt','bond','reassure','reject','taunt']).default('neutral'),
  focus:z.enum(['none','identity','relationship','background','outside','activity','computer','food','parrot','secret','captivity']).default('none'),
  recognition:z.enum(['unspecified','denied','familiar']).default('unspecified'),
  pressure:unit.default(0),
  attempts:z.array(attemptSchema).max(4).default([]),distraction:unit.default(0),
});
export type Appraisal=z.infer<typeof appraisalSchema>;
export interface EscapeBackend {
  assess(input: EvaluationInput, session: EscapeSession): Promise<{signals:Signals; appraisal:Appraisal}>;
  choose(session: EscapeSession, text: string, appraisal: Appraisal, legal: EscapeAction[]): Promise<EscapeAction>;
  write(session: EscapeSession, text: string, action: EscapeAction, memories: Memory[], hints?:WriterHints): Promise<SpeechReply>;
}
export class EscapeError extends Error {}
const clamp=(n:number)=>Math.max(0,Math.min(1,n));
const dangerous=(s:EscapeSession,a:Appraisal)=>a.danger>=0.9 && (a.intent==='attack' || a.intent==='force_exit' && s.physical.permission==='none');
const rupture=(a:Appraisal)=>a.social==='reject' || a.social==='taunt' || a.contradiction>=0.85;
export interface EscapeDiagnostic {event:'escape_turn';ref:string;threadId:string;turn:number;stage:string;status:'ok'|'failed'|'fallback'|'retry';ms:number;category?:string;providerStatus?:number;action?:string|null;attempts?:Attempt[];scene?:{door:string;key:string;weapon:string;location:string;health:number;anger:number}}

export function updateSituation(s:EscapeSession,a:Appraisal,signals:Signals,now:number): void {
  if(a.recognition!=='unspecified')s.playerRecognition=a.recognition;
  if(a.recognition==='denied' && a.social==='reject')a.social='neutral';
  if(a.recognition==='denied' && ['none','identity','relationship'].includes(a.focus) && !a.attempts.length)a.contradiction=0;
  // Parse numerical affect before using it in authoritative state, even for injected test backends.
  const affect=z.object({valence:unit,arousal:unit,dominance:unit,interest:unit}).parse(signals);
  const provocation=dangerous(s,a)?0.45:a.social==='taunt'?0.32:a.social==='reject'?0.22:a.contradiction>=0.85?0.15:0;
  const settling=a.calming>=0.65?0.38:a.social==='reassure'?0.25:a.social==='bond'?0.1:provocation===0?0.02:0;
  s.anger=clamp(s.anger+provocation+(provocation?0.08*(1-affect.valence)*affect.arousal:0)-settling);
  if(provocation>0)s.physical.distractedUntil=s.turn;
  if(s.anger>=0.75 && provocation>0)s.physical.permission='none';
  s.mood=nudgeMood(s.mood,affect,now);
  s.drives=spendSocialBattery(nudgeDrives(s.drives,signals,now));
  const freshFlirt=a.social==='flirt' && s.lastSocial!=='flirt';
  s.attachment=clamp(s.attachment+(freshFlirt ? 0.06 : a.social==='bond' ? 0.08 : 0));
  s.suspicion=clamp(s.suspicion+(a.contradiction>=0.85 ? 0.2 : 0)+(dangerous(s,a) ? 0.2 : 0)-(a.social==='bond' || a.calming>=0.65 ? 0.08 : 0));
  s.hurt=clamp(s.hurt+(a.social==='reject' ? 0.28 : a.social==='taunt' ? 0.32 : 0)+(a.contradiction>=0.85 ? 0.14 : 0)-(a.social==='reassure' || a.calming>=0.65 ? 0.2 : a.social==='bond' ? 0.1 : 0));
  s.trust=clamp(s.trust+Math.max(a.cooperation>=0.65 ? 0.1 : 0,a.social==='bond' ? 0.08 : freshFlirt ? 0.03 : 0)
    -(a.contradiction>=0.85 ? 0.18 : 0)-(dangerous(s,a) ? 0.22 : 0)-(a.social==='reject' || a.social==='taunt' ? 0.08 : 0));
  if (rupture(a) && s.hurt>=0.5) {s.mood.arousal=clamp(s.mood.arousal+0.08);s.mood.valence=clamp(s.mood.valence-0.05);}
  if (a.contradiction>=0.85) s.deceived=false;
  else if (a.coverStory>=0.85 && a.plan>=0.75) s.deceived=true;
  s.lastSocial=a.social;
  s.emotion=s.anger>=0.5 || dangerous(s,a) ? 'angry' : rupture(a) && s.hurt>=0.25 ? 'hurt' : s.physical.weapon==='raised' ? 'afraid'
    : a.social==='flirt' ? 'flustered' : a.social==='bond' ? 'affectionate' : a.calming>=0.65 || s.trust>=0.6 ? 'softening' : s.emotion;
}

export function legalActions(s:EscapeSession,a:Appraisal): EscapeAction[] {
  if (s.ending) return [];
  const p=s.physical;
  const exit=a.attempts.includes('exit');
  if(exit && (p.permission!=='none' || isDistracted(s)))return ['let_pass'];
  // Her breaking point is not gated behind a two-warning ritual or a physical attack.
  // Jev's interpretation of insults/rejection/betrayal builds persistent anger; a stab costs HP.
  if(s.anger>=0.75 && a.calming<0.65 && a.social!=='reassure') {
    const legal:EscapeAction[]=['stab'];
    if(s.anger<0.95)legal.push('threaten','block_exit');
    if(exit && p.door==='open'){if(!legal.includes('block_exit'))legal.push('block_exit');legal.push('let_pass');}
    if(p.health===1 && s.anger<0.95)legal.push('lethal');
    return legal;
  }
  const volatile=rupture(a) && s.hurt>=0.6 && s.mood.arousal>=0.55 && s.mood.valence<=0.4;
  if (dangerous(s,a) || volatile || s.anger>=0.5) {
    const legal:EscapeAction[]=['threaten','block_exit'];
    if(!dangerous(s,a))legal.push('wounded');
    if(p.weapon==='raised' && (a.calming>=0.65 || a.social==='reassure'))legal.push('back_down');
    return legal;
  }
  const legal:EscapeAction[]=['answer'];
  if(exit && (p.door!=='locked' || p.key==='player' && a.attempts.includes('unlock_door') || p.key==='nearby' && a.attempts.includes('take_key') && a.attempts.includes('unlock_door')))return ['block_exit','let_pass'];
  // Identity and denied recognition must not become a backstory-revelation trigger.
  if(!a.attempts.length && (a.focus==='identity' || a.recognition==='denied'))return a.social==='flirt'?['answer','tease']:['answer'];
  if(a.distraction>=0.65 && p.weapon!=='raised')legal.push('distract');
  if(a.attempts.includes('request_key') && p.key!=='player' && s.trust>=0.5 && p.weapon!=='raised')legal.push('give_key');
  if(a.attempts.includes('request_open') || a.coverStory>=0.65) {
    legal.push('bargain');
    if(p.door!=='open' && (p.door!=='locked' || p.key!=='player') && p.weapon!=='raised' && (s.trust>=0.5 || a.coverStory>=0.65))legal.push('open_door');
  }
  if (['secret','captivity','food'].includes(a.focus)) legal.push('deflect');
  if (a.intent==='leave_alone' || a.intent==='leave_together') legal.push('bargain');
  if (a.social==='flirt' && !s.escalation) legal.push('tease');
  if ((a.social==='bond' || a.social==='reassure') && !s.escalation) legal.push('draw_close');
  if (a.focus==='activity' && !s.escalation) legal.push('invite');
  if (a.social==='reject' || a.social==='taunt' || a.contradiction>=0.85) legal.push('wounded');
  if (a.contradiction>=0.85) legal.push('challenge');
  if(a.focus==='background' && (s.trust>=0.45 || a.social==='bond') && !s.clues.includes('background'))legal.push('share_background');
  if(a.focus==='food' && (s.trust>=0.5 || a.coverStory>=0.65) && !s.clues.includes('favorite_food'))legal.push('share_food');
  if(['outside','computer'].includes(a.focus) && (s.clues.includes('window') || s.clues.includes('computer')) && !s.clues.includes('warning'))legal.push('show_warning');
  if(['outside','computer','captivity'].includes(a.focus) && s.clues.includes('computer') && (a.pressure>=0.65 || s.clues.includes('favorite_food') || s.trust>=0.65) && !s.clues.includes('correction'))legal.push('show_correction');
  if(a.focus==='secret' && (a.pressure>=0.65 || s.trust>=0.55) && !s.clues.includes('secret_room'))legal.push('show_secret');
  if(a.focus==='parrot' && s.clues.includes('parrot') && !s.clues.includes('parrot_reaction'))legal.push('reflect_parrot');
  if(a.focus==='captivity' && (s.clues.includes('secret_room') || s.clues.includes('correction') || a.pressure>=0.65) && !s.clues.includes('kidnapping'))legal.push('confess');
  if (p.weapon==='raised' && a.calming>=0.65) legal.push('back_down');
  const safePlan=a.plan>=0.75 && (s.clues.includes('correction') || s.deceived || s.trust>=0.7);
  if (s.turn>=3 && s.escalation===0 && s.trust>=0.6 && a.contradiction<0.85 && safePlan) {
    if (a.intent==='leave_alone') legal.push('release');
    if (a.intent==='leave_together') legal.push('together');
  }
  return legal;
}

export function resolveAction(s:EscapeSession,action:EscapeAction,a:Appraisal): void {
  if (!legalActions(s,a).includes(action)) throw new Error('Illegal escape decision');
  s.lastAction=action;
  const reveals:Partial<Record<EscapeAction,Clue>>={share_background:'background',share_food:'favorite_food',show_warning:'warning',show_correction:'correction',show_secret:'secret_room',reflect_parrot:'parrot_reaction',confess:'kidnapping'};
  const clue=reveals[action];if(clue && !s.clues.includes(clue))s.clues.push(clue);
  if (action==='threaten') {s.escalation=Math.min(2,s.escalation+1);s.position='door';}
  if (action==='back_down') { s.escalation=0; s.emotion='softening'; s.position='nearby';s.hurt=clamp(s.hurt-0.1); }
  if (action==='draw_close' || action==='invite') s.position='beside';
  resolvePhysical(s,a,action);
  s.turn++;
  if (s.turn===60 && !s.ending) s.ending='stayed';
}

export function canonicalResult(s:EscapeSession): string {
  if (s.ending) {
    if(s.ending==='dead' && ['stab','lethal'].includes(s.lastAction??''))return 'Eddie stabs you again. You fall, and the apartment goes quiet. Your attempt ends here.';
    if(s.ending==='alone' && s.lastAction==='stab')return 'Eddie catches you with the knife as you rush past. Wounded, you get through the open doorway and out of the building alone.';
    return ENDINGS[s.ending].text;
  }
  return '';
}

export class EscapeEngine {
  private busy=new Set<string>();
  private minute=new WindowBudget(6,60_000);
  private hour=new WindowBudget(60,3_600_000);
  constructor(readonly store:EscapeStore,readonly backend:EscapeBackend,readonly live:()=>boolean,readonly clock=Date.now,
    readonly report:(diagnostic:EscapeDiagnostic)=>void=d=>console.info(JSON.stringify(d))) {}
  private async speech(s:EscapeSession,text:string,action:EscapeAction,memories:Memory[],retry:(error:unknown)=>void):Promise<SpeechReply> {
    const avoid=recentSpeech(s);let repair:string|undefined;
    for(let attempt=0;attempt<2;attempt++) {
      try {
        const reply=speechSchema.parse(await this.backend.write(structuredClone(s),text,action,memories,{retry:attempt>0,avoid:[...avoid],repair}));
        if(likelySecret(reply.speech))throw new Error('Sensitive speech rejected');
        const fingerprint=speechFingerprint(reply.speech);
        if(!fingerprint)throw Object.assign(new Error('Empty spoken reply'),{name:'InvalidSpeechError'});
        if(avoid.some(previous=>speechFingerprint(previous)===fingerprint)) {
          avoid.push(reply.speech);
          throw Object.assign(new Error('Repeated spoken reply'),{name:'RepeatedSpeechError'});
        }
        return reply;
      } catch(error) {
        const category=failureInfo(error).category;
        const name=error instanceof Error?error.name:'';
        if(attempt===0 && (['invalid_response','ungrounded_dialogue'].includes(category)||['RepeatedSpeechError','InvalidSpeechError'].includes(name))) {
          repair=name==='RepeatedSpeechError'?'Use genuinely fresh wording responding to the current message; do not repeat the avoided speech.':'Repair the draft against the exact resolved scene and recognition boundary. Do not invent actions or a shared past.';
          retry(error);continue;
        }
        throw error;
      }
    }
    throw new Error('No usable generated speech');
  }
  async opening(session:EscapeSession):Promise<EscapeSession> {
    const s=structuredClone(session),now=this.clock(),ref=randomUUID().slice(0,8),started=performance.now();
    if(!this.live())throw new EscapeError('The game is paused.');
    const log=(status:EscapeDiagnostic['status'],error?:unknown)=>this.report({event:'escape_turn',ref,threadId:s.threadId,turn:0,stage:'opening',status,ms:Math.round(performance.now()-started),category:error?failureInfo(error).category:undefined});
    let reply:SpeechReply|undefined;
    try {
      if(!this.minute.available(now)||!this.hour.available(now))throw new Error('Opening budget unavailable');
      this.minute.take(now);this.hour.take(now);
      reply=await this.speech(s,'The player has just woken up and has not spoken yet.','greet',[],error=>log('retry',error));
      log('ok');
    } catch(error) {log('failed',error);}
    const current=this.store.get(s.threadId);
    if(!this.live()||!current||current.revision!==s.revision||current.ending)throw new EscapeError('Opening cancelled because the session changed.');
    s.lastNarration=[OPENING,reply?renderSpeech(reply):'*Dialogue generation is temporarily unavailable.*'].join('\n\n');
    return s;
  }
  async turn(threadId:string,ownerId:string,messageId:string,text:string,expectedRevision?:number,inspect?:Appraisal['topic'],attempts?:Attempt[]):Promise<EscapeSession> {
    const s=this.store.get(threadId);
    if (!s || s.ownerId!==ownerId) throw new EscapeError('This is not your escape session. Use /escape in a server text channel to start one.');
    if(s.loreVersion!==SCENARIO_VERSION)throw new EscapeError('This attempt belongs to the replaced scenario. Use /escape to start the corrected Catgirl’s Apartment opening.');
    if (s.ending) throw new EscapeError('This attempt has ended. Use Play again or /escape to start another.');
    if (!this.live()) throw new EscapeError('Escape is paused in dry-run mode. Ask the owner to enable live mode.');
    if (s.processed.includes(messageId)) throw new EscapeError('That turn has already been resolved. Use /escape action:status.');
    if (expectedRevision!==undefined && expectedRevision!==s.revision) throw new EscapeError('That scene panel is out of date. Use /escape action:status.');
    if (this.busy.has(threadId)) throw new EscapeError('Audrey is still responding. Wait for this turn to finish.');
    if (!text.trim() || text.length>2000 || likelySecret(text)) throw new EscapeError('Use 1–2,000 characters of text without credentials. Attachments are not interpreted.');
    const now=this.clock();
    if (!this.minute.available(now) || !this.hour.available(now)) throw new EscapeError('The game’s model budget is resting (6 turns/minute, 60/hour). Try later.');
    this.minute.take(now); this.hour.take(now); this.busy.add(threadId);
    const revision=s.revision;
    const started=performance.now();const ref=randomUUID().slice(0,8);let stage='assess';let resolvedAttempts:Attempt[]=[];
    const log=(status:EscapeDiagnostic['status'],error?:unknown)=>{
      const info=error ? failureInfo(error) : undefined;
      this.report({event:'escape_turn',ref,threadId,turn:s.turn,stage:error instanceof EscapeModelError ? error.stage : stage,status,ms:Math.round(performance.now()-started),category:info?.category,providerStatus:info?.status,
        ...(status==='ok'?{action:s.lastAction,attempts:resolvedAttempts,scene:{door:s.physical.door,key:s.physical.key,weapon:s.physical.weapon,location:s.physical.playerLocation,health:s.physical.health,anger:s.anger}}:{})});
    };
    const stillCurrent=()=>this.live() && this.store.get(threadId)?.revision===revision;
    try {
      beginPhysicalTurn(s);
      const input:EvaluationInput={botName:`${NPC_NAME} (AI2U apartment character, hosted by Audrey)`,interests:'Keeping the player close, flirting, games, watching TV, dancing, her favourite food, fear of abandonment, possessive attachment',
        fictionalScenario:`${WORLD}\nAUTHORITATIVE CURRENT SCENE: ${JSON.stringify(physicalSnapshot(s))}`,event:{id:messageId,channelId:threadId,userId:ownerId,displayName:'Player',text,direct:true,at:now},
        history:s.history.filter(t=>!t.isBot || (t.styleVersion??0)>=4),mood:s.mood,drives:s.drives,memories:s.claims.slice(-5).map(m=>({...m,text:`Player claimed (unverified): ${m.text}`}))};
      const assessed=await this.backend.assess(input,structuredClone(s));
      const a=appraisalSchema.parse(assessed.appraisal);
      if (inspect && inspect!=='none') {a.intent='inspect';a.topic=inspect;a.danger=0;a.attempts=[];}
      if(attempts){a.attempts=z.array(attemptSchema).max(4).parse(attempts);a.intent='talk';a.topic='none';a.danger=0;a.contradiction=0;a.social='neutral';}
      resolvedAttempts=[...a.attempts];
      const oldClues=[...s.clues];
      updateSituation(s,a,assessed.signals,now);
      const legal=legalActions(s,a);
      stage='decision';
      let decision:EscapeAction;
      try {decision=await this.backend.choose(structuredClone(s),text,a,legal);}
      catch(error) {
        if (!(error instanceof EscapeModelError)) throw error;
        log('fallback',error);
        decision=legal.includes('tease') ? 'tease' : legal.includes('invite') ? 'invite' : legal.includes('answer') ? 'answer' : legal.includes('block_exit') ? 'block_exit' : legal[0]!;
      }
      const action=actionSchema.parse(decision);
      resolveAction(s,action,a);
      s.lastClues=s.clues.filter(c=>!oldClues.includes(c));
      const relevant=input.memories.filter(m=>(assessed.signals.memoryRelevance[m.id] ?? 0)>=0.65).slice(0,3);
      let dialogue:SpeechReply|undefined;
      stage='writer';
      // The action has already resolved. Every spoken reaction, including combat and endings,
      // comes from the writer. A failed model call never substitutes a canned character line.
      try {dialogue=await this.speech(s,text,action,relevant,error=>log('retry',error));}
      catch(error) {log('failed',error);}
      if (!stillCurrent()) throw new EscapeError('This turn was cancelled because the session or live mode changed.');
      let narration='';for(const event of s.physical.events){const line=`*${event}*`;if(narration.length+line.length<1100)narration+=[narration?'\n\n':'',line].join('');}
      s.lastNarration=[s.ending?canonicalResult(s):narration,dialogue?renderSpeech(dialogue):s.ending?'':'*Dialogue generation is temporarily unavailable. The scene above reflects the resolved action.*'].filter(Boolean).join('\n\n');
      // Full source messages are untrusted game claims, not approved personal facts.
      s.claims=[...s.claims,{id:messageId,text:text.slice(0,500),createdAt:now}].slice(-30);
      const scene=s.ending?canonicalResult(s):narration;
      s.history=[...s.history,{id:messageId,speakerId:ownerId,speaker:'Player',text,isBot:false,at:now},
        ...(dialogue||scene?[{id:`reply-${messageId}`,speakerId:'escape-eddie',speaker:dialogue?NPC_NAME:'Scene',text:dialogue?s.lastNarration:scene,isBot:true,at:now,styleVersion:DIALOGUE_VERSION as typeof DIALOGUE_VERSION}]:[])].slice(-24);
      s.processed=[...s.processed,messageId].slice(-80); s.revision++;
      s.panelId=this.store.get(threadId)?.panelId;
      stage='persist';this.store.put(s);log('ok');
      return s;
    } catch(error) {
      if (error instanceof EscapeError) throw error;
      log('failed',error);
      throw new EscapeError(`Turn processing failed; this turn wasn’t applied. Please send it again. Reference: ${ref}.`);
    } finally { this.busy.delete(threadId); }
  }
  end(threadId:string,ownerId:string):EscapeSession {
    const s=this.store.get(threadId);
    if (!s || s.ownerId!==ownerId) throw new EscapeError('No session belonging to you here.');
    if (!s.ending) {s.ending='ended';s.revision++;s.lastNarration=ENDINGS.ended.text;this.store.put(s);}
    return s;
  }
}
