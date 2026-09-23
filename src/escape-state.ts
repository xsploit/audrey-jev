import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomInt } from 'node:crypto';
import { z } from 'zod';
import { baseline } from './state.js';
import { decayDrives } from './drives.js';
import { OPENING, ACTIONS, CLUES, FAVORITE_FOODS, SCENARIO_VERSION, type Clue, type EscapeAction } from './escape-scenario.js';
import { physicalSchema } from './escape-physical.js';

const unit = z.number().finite().min(0).max(1);
const id = z.string().min(1).max(100);
const time = z.number().finite().nonnegative();
export const clueSchema = z.enum(Object.keys(CLUES) as [Clue,...Clue[]]);
export const actionSchema = z.enum(Object.keys(ACTIONS) as [EscapeAction,...EscapeAction[]]);
const storedClueSchema=clueSchema.or(z.enum(['scar','chart','radio','confession','connection','surgery','sedation','alteration','coat']));
const storedActionSchema=actionSchema.or(z.enum(['reminisce','admit_surgery','admit_sedation','admit_alteration']));
export const sessionSchema = z.object({
  threadId: id, guildId: id, parentId: id, ownerId: id,
  revision: z.number().int().nonnegative(), turn: z.number().int().min(0).max(60), createdAt: time,
  panelId: id.optional(), ending: z.enum(['alone','together','dead','stayed','ended']).nullable(),
  physical:physicalSchema.prefault({}),
  mood: z.object({valence:unit,arousal:unit,dominance:unit,updatedAt:time}),
  drives: z.object({curiosity:unit,socialBattery:unit,tension:unit,updatedAt:time}),
  emotion: z.enum(['guarded','afraid','angry','softening','affectionate','flustered','hurt']), trust: unit,
  attachment: unit.default(0.75), suspicion: unit.default(0.25), hurt: unit.default(0),
  anger:unit.default(0.15),
  position: z.enum(['beside','nearby','door']).default('nearby'),
  lastSocial: z.enum(['neutral','flirt','bond','reassure','reject','taunt']).default('neutral'),
  loreVersion: z.union([z.literal(1),z.literal(2),z.literal(3)]).default(1),
  playerRecognition:z.enum(['unknown','denied','familiar']).default('unknown'),
  favoriteFood:z.enum(FAVORITE_FOODS).default('fishcake'),
  escalation: z.number().int().min(0).max(2), deceived: z.boolean(),
  clues: z.array(storedClueSchema).max(20), lastClues: z.array(storedClueSchema).max(20).default([]),
  history: z.array(z.object({id,speakerId:id,speaker:z.string().max(80),text:z.string().max(2000),isBot:z.boolean(),at:time,styleVersion:z.union([z.literal(2),z.literal(3),z.literal(4),z.literal(5)]).optional()})).max(24),
  claims: z.array(z.object({id,text:z.string().max(500),createdAt:time})).max(30),
  processed: z.array(id).max(80),
  lastAction: storedActionSchema.nullable(),
  lastNarration: z.string().max(2000),
});
export type EscapeSession = z.infer<typeof sessionSchema>;
const diskSchema = z.object({version:z.literal(1), sessions:z.record(z.string(),sessionSchema), retired:z.array(id)});
type Disk = z.infer<typeof diskSchema>;

export function newSession(threadId: string, guildId: string, parentId: string, ownerId: string, now = Date.now()): EscapeSession {
  return sessionSchema.parse({threadId,guildId,parentId,ownerId,revision:0,turn:0,createdAt:now,ending:null,
    mood:{...baseline,arousal:0.55,updatedAt:now},drives:decayDrives(undefined,now),trust:0.4,
    loreVersion:SCENARIO_VERSION,position:'beside',emotion:'affectionate',favoriteFood:FAVORITE_FOODS[randomInt(FAVORITE_FOODS.length)],
    escalation:0,deceived:false,clues:[],history:[],claims:[],processed:[],lastAction:null,lastNarration:OPENING});
}

// A separate file and object graph: game claims can never become companion memories.
export class EscapeStore {
  private data: Disk;
  constructor(readonly file?: string) {
    try { this.data = file && existsSync(file) ? diskSchema.parse(JSON.parse(readFileSync(file,'utf8'))) : {version:1,sessions:{},retired:[]}; }
    catch { throw new Error('Escape state is invalid; back it up and repair it. Refusing to overwrite sessions.'); }
    for (const [key,s] of Object.entries(this.data.sessions)) {
      if (key !== s.threadId) throw new Error('Escape thread index is invalid');
      if(['alone','together'].includes(s.ending ?? '')){s.physical.door='open';s.physical.playerLocation='outside';}
      if(s.ending==='dead')s.physical.health=0;
      if(s.escalation>0 && s.physical.weapon==='concealed')s.physical.weapon='raised';
    }
  }
  get(threadId: string): EscapeSession | undefined { const s=this.data.sessions[threadId]; return s && structuredClone(s); }
  ownsThread(threadId: string): boolean { return Boolean(this.data.sessions[threadId]) || this.data.retired.includes(threadId); }
  active(guildId: string, ownerId: string): EscapeSession | undefined {
    const s=Object.values(this.data.sessions).find(s=>s.guildId===guildId && s.ownerId===ownerId && !s.ending);
    return s && structuredClone(s);
  }
  put(session: EscapeSession): void {
    const s=sessionSchema.parse(session);
    if (!this.data.sessions[s.threadId] && Object.keys(this.data.sessions).length >= 500) throw new Error('Escape storage is full; forget old sessions first.');
    this.commit({...this.data,sessions:{...this.data.sessions,[s.threadId]:s}});
  }
  forget(threadId: string): void {
    const sessions={...this.data.sessions}; delete sessions[threadId];
    this.commit({...this.data,sessions,retired:[...new Set([...this.data.retired,threadId])]});
  }
  private commit(next: Disk): void {
    diskSchema.parse(next);
    if (this.file) {
      mkdirSync(dirname(this.file),{recursive:true,mode:0o700});
      writeFileSync(`${this.file}.tmp`,JSON.stringify(next,null,2),{mode:0o600});
      renameSync(`${this.file}.tmp`,this.file);
    }
    this.data=next;
  }
}
