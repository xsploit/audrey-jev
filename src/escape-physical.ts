import { z } from 'zod';
import type { EscapeSession } from './escape-state.js';
import type { Appraisal } from './escape-engine.js';
import { isClue, NPC_NAME, type EscapeAction } from './escape-scenario.js';

// Only the escape's concrete mechanisms live here. Calls, visitors, emergencies and other
// improvised stories are conversational evidence for Jev, not additional simulation subsystems.
export const ATTEMPTS={
  none:'No concrete key/door action. Conversation, roleplay claims or hypothetical plans only.',
  move_door:'Actually approach the doorway.',inspect_key:'Look for or examine the apartment key.',inspect_door:'Examine the door or lock.',
  request_key:'Ask Eddie to give the player the actual key.',take_key:'Actually take or steal the key; claimed possession must be checked.',
  request_open:'Ask or trick Eddie into unlocking/opening the door herself. This can be indirect or spoken as part of a roleplayed pretext.',
  unlock_door:'Use the key to unlock the door. Unlocking does not imply opening it.',
  open_door:'Turn the handle and open the door. Opening does not imply leaving.',
  exit:'Actually walk/run through the doorway to leave, not merely ask permission.',
} as const;
export const attemptSchema=z.enum(Object.keys(ATTEMPTS) as [keyof typeof ATTEMPTS,...(keyof typeof ATTEMPTS)[]]);
export type Attempt=z.infer<typeof attemptSchema>;
export const physicalSchema=z.object({
  door:z.enum(['locked','unlocked','open']).default('locked'),
  key:z.preprocess(value=>value==='coat'?'held':value==='chair'?'nearby':value,z.enum(['held','nearby','player']).default('held')),
  playerLocation:z.enum(['inside','door','outside']).default('inside'),
  weapon:z.enum(['concealed','raised','lowered']).default('concealed'),
  health:z.number().int().min(0).max(3).default(3),
  blocking:z.boolean().default(false),
  distractedUntil:z.number().int().nonnegative().default(0),
  permission:z.enum(['none','alone','together']).default('none'),
  events:z.array(z.string().max(400)).max(12).default([]),
});
export type PhysicalState=z.infer<typeof physicalSchema>;
export const isDistracted=(s:EscapeSession)=>s.turn<s.physical.distractedUntil;
export function inventory(s:EscapeSession):string[] {return s.physical.key==='player'?['Apartment key']:[];}
export function physicalSnapshot(s:EscapeSession) {
  return {...s.physical,inventory:inventory(s),npcName:NPC_NAME,npcPosition:s.position,distracted:isDistracted(s),ending:s.ending};
}
const note=(s:EscapeSession,text:string)=>{if(s.physical.events.length<12)s.physical.events.push(text);};
export function beginPhysicalTurn(s:EscapeSession):void {s.physical.events=[];}
function unlock(s:EscapeSession):boolean {
  const p=s.physical;p.playerLocation='door';
  if(p.door!=='locked'){note(s,'The lock is already released.');return true;}
  if(p.key!=='player'){note(s,`The deadbolt holds. You do not have the apartment key; ${NPC_NAME} can also unlock it herself.`);return false;}
  p.door='unlocked';note(s,'Your key turns in the lock. The door is unlocked, but still closed.');return true;
}
function open(s:EscapeSession):boolean {
  const p=s.physical;p.playerLocation='door';
  if(p.door==='locked'){note(s,'You try the handle, but the deadbolt is still locked. The door does not open.');return false;}
  if(p.door==='unlocked'){p.door='open';note(s,'You turn the handle and open the apartment door.');}
  return true;
}

export function resolvePhysical(s:EscapeSession,a:Appraisal,action:EscapeAction):void {
  const p=s.physical;
  if(action==='give_key' && p.key!=='player'){p.key='player';note(s,`${NPC_NAME} places the apartment key in your hand. You now have it.`);}
  if(action==='distract') {
    const putsKeyDown=p.key==='held';if(putsKeyDown)p.key='nearby';p.distractedUntil=s.turn+2;p.blocking=false;s.position='nearby';
    note(s,`${NPC_NAME} ${putsKeyDown?'sets the key down and gives':'gives'} her attention to your concern instead of guarding the exit.${p.key==='nearby'?' The key is momentarily within reach.':''}`);
  }
  if(action==='block_exit'){note(s,p.blocking?`${NPC_NAME} remains in the doorway, still blocking your path.`:`${NPC_NAME} steps into your path at the doorway. She is blocking the exit.`);p.blocking=true;s.position='door';}
  if(action==='let_pass'){p.blocking=false;s.position='nearby';}
  if(action==='threaten'){
    note(s,p.weapon==='raised'?'Eddie keeps the knife raised, watching your next move.':'Eddie’s eyes turn red as she draws the knife.');
    p.weapon='raised';p.blocking=true;
  }
  if(action==='stab' || action==='lethal') {
    const draws=p.weapon!=='raised';p.weapon='raised';p.permission='none';p.blocking=false;s.position='nearby';
    p.health=Math.max(0,p.health-1);
    note(s,`${draws?'Eddie draws her knife and lunges.':'Eddie lunges with the knife.'} She stabs you. ${p.health ? 'You stagger back, wounded.' : 'You fall, unable to get away.'}`);
    if(p.health===0){s.ending='dead';return;}
  }
  if(action==='back_down'){p.weapon='lowered';p.blocking=false;note(s,'Eddie lowers the knife and eases back.');}
  if(action==='release' || action==='together' || action==='open_door') {
    if(action!=='open_door')p.permission=action==='together'?'together':'alone';
    p.blocking=false;s.position='nearby';
    if(p.door==='locked' && p.key!=='player') {
      p.key='held';p.door='open';note(s,`${NPC_NAME} uses her key to unlock and open the door, then steps aside.`);
    } else if(p.door==='unlocked') {
      p.door='open';note(s,`${NPC_NAME} opens the already-unlocked door and steps aside.`);
    } else note(s,p.door==='locked'?`${NPC_NAME} agrees to let you leave and steps aside. You have the key; the door still needs unlocking.`:`${NPC_NAME} agrees to let you leave and steps aside.`);
    if(action==='together')note(s,'She is ready to leave with you when you cross the threshold.');
  }
  if(a.intent==='inspect' && isClue(a.topic) && a.topic!=='key' && !s.clues.includes(a.topic))s.clues.push(a.topic);
  const attempts=[...a.attempts];
  if(a.intent==='inspect' && (a.topic==='key'||a.topic==='door'))attempts.unshift(`inspect_${a.topic}`);
  for(const attempt of [...new Set(attempts)]) {
    if(attempt==='none'||attempt==='request_key'||attempt==='request_open')continue;
    if(attempt==='move_door'){p.playerLocation='door';note(s,'You approach the apartment door.');}
    else if(attempt==='inspect_key') {
      if(p.key==='player')note(s,'The apartment key is already in your hand.');
      else {if(!s.clues.includes('key'))s.clues.push('key');note(s,p.key==='nearby'?'The apartment key is visible nearby, within reach.':`${NPC_NAME} is keeping the apartment key close to her.`);}
    }
    else if(attempt==='inspect_door')note(s,`The door is ${p.door}. ${p.blocking?`${NPC_NAME} is blocking the threshold.`:'There is a keyed lock and a normal handle.'}`);
    else if(attempt==='take_key') {
      if(p.key==='player')note(s,'The apartment key is already in your hand.');
      else if(p.key==='held' && !isDistracted(s)){note(s,`${NPC_NAME} has the key. You cannot simply take it while she is watching your hands.`);break;}
      else {p.key='player';note(s,'You take the brass apartment key. It is now in your inventory.');}
    }
    else if(attempt==='unlock_door'){if(!unlock(s))break;}
    else if(attempt==='open_door'){if(!open(s))break;}
    else if(attempt==='exit') {
      if(!open(s))break;
      if(p.blocking && !isDistracted(s) && p.permission==='none'){note(s,`The door is open, but ${NPC_NAME} is still in your path. You have not crossed the threshold.`);break;}
      p.playerLocation='outside';s.ending=p.permission==='together'?'together':'alone';
      note(s,'You cross the open doorway and head down the apartment stairs toward the lobby.');break;
    }
  }
}
