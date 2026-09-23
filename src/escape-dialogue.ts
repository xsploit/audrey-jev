import { z } from 'zod';
import { CHARACTER, RELATIONSHIP, OPENING, NPC_NAME, clueRecords } from './escape-scenario.js';
import type { EscapeSession } from './escape-state.js';
import { physicalSnapshot } from './escape-physical.js';

export const speechSchema=z.object({speech:z.string().trim().min(1).max(700)}).strict();
export type SpeechReply=z.infer<typeof speechSchema>;
export interface WriterHints { retry:boolean;avoid:string[];repair?:string }
export function renderSpeech(reply:SpeechReply):string {
  return `“${reply.speech.replace(/[“”"*_`]/g,'').replace(/\s+/g,' ').trim()}”`;
}
export function cleanDialogue(text:string):string {
  const body=text.split(/(?:^|\n)\s*(?:\*\*)?(?:Scene record|Scene updated|Journal updated)\b/i)[0] ?? '';
  const seen=new Set<string>();
  return body.trim().split(/\n\s*\n/).filter(p=>{const key=p.trim().toLowerCase();if(seen.has(key))return false;seen.add(key);return true;}).join('\n\n');
}
export function speechFromNarration(narration:string):string {
  const text=cleanDialogue(narration).replace(/\*[^*]*\*/g,' ');
  return [...text.matchAll(/“([^”]+)”|"([^"\n]+)"/g)].map(m=>m[1]??m[2]??'').join(' ').replace(/\s+/g,' ').trim();
}
export const speechFingerprint=(text:string)=>text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
export function recentSpeech(s:EscapeSession):string[] {
  return [...new Set([s.lastNarration,...s.history.filter(t=>t.isBot).slice(-6).map(t=>t.text)].map(speechFromNarration).filter(Boolean))];
}
export function writerContext(s:EscapeSession) {
  return {
    character:CHARACTER,relationshipBoundary:RELATIONSHIP,
    privateProfile:{favoriteFood:s.favoriteFood},
    playerKnowledge:{recognition:s.playerRecognition,establishedSharedPast:[],girlfriendStatus:'Eddie’s claim; not a player-confirmed relationship'},
    publicSetup:`The player woke in the unfamiliar living room of apartment 201. You are ${NPC_NAME}, the catgirl. The city is burning outside. A TV, photographs, a bookshelf and an incomplete blue parrot statue are present. The current state determines the exit door and key.`,
    openingContext:OPENING,
    authoritativeScene:physicalSnapshot(s),resolvedEvents:s.physical.events,
    revealedFacts:clueRecords(s.clues,s.favoriteFood),
    currentBeat:s.lastAction,position:s.position,emotion:s.emotion,
    fictionalMood:s.mood,fictionalDrives:s.drives,
    relationship:{attachment:s.attachment,trust:s.trust,suspicion:s.suspicion,hurt:s.hurt,anger:s.anger,approach:s.lastSocial},
    history:s.history.filter(t=>!t.isBot || (t.styleVersion??0)>=4).slice(-12).map(t=>({speaker:t.speaker,text:t.isBot?cleanDialogue(t.text):t.text})),
  };
}
