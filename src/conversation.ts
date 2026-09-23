import { likelySecret } from './policy.js';
import type { ConversationContext, Event, ReplyChainTurn, Turn } from './types.js';

const CACHE_MS=30*60_000;
const CONTINUE_MS=3*60_000;
const HISTORY_MS=15*60_000;
const CACHE_TURNS=64;
const MAX_CHANNELS=128;
interface TrackedTurn { turn: Turn; conversationId: string; ownerId: string; addressedToOther: boolean }
interface Channel { turns: TrackedTurn[]; rejected: Map<string,number>; touched: number }
export interface Selection { history: Turn[]; context: ConversationContext }
const clean = (turn: Turn): Turn => ({...turn,text:turn.text.slice(0,1000),speaker:turn.speaker.slice(0,80)});

/** Structural heuristics, not semantic topic recognition. Reply links override recency. */
export class ConversationTracker {
  private channels=new Map<string,Channel>();
  private channel(id:string,now:number):Channel {
    for(const [key,c] of this.channels) if(now-c.touched>CACHE_MS) this.channels.delete(key);
    let channel=this.channels.get(id);
    if(!channel) {
      if(this.channels.size>=MAX_CHANNELS) {
        const oldest=[...this.channels].sort((a,b)=>a[1].touched-b[1].touched)[0];
        if(oldest) this.channels.delete(oldest[0]);
      }
      channel={turns:[],rejected:new Map(),touched:now};this.channels.set(id,channel);
    }
    channel.touched=now;
    channel.turns=channel.turns.filter(row=>now-row.turn.at<CACHE_MS).slice(-CACHE_TURNS);
    for(const [key,time] of channel.rejected) if(now-time>CACHE_MS) channel.rejected.delete(key);
    return channel;
  }
  clear(channelId:string):void { this.channels.delete(channelId); }
  isRejected(channelId:string,id:string,now:number):boolean { return this.channel(channelId,now).rejected.has(id); }
  reject(channelId:string,id:string,now:number):void {
    const c=this.channel(channelId,now);c.turns=c.turns.filter(r=>r.turn.id!==id);
    c.rejected.set(id,now);
    if(c.rejected.size>128) c.rejected.delete(c.rejected.keys().next().value!);
  }
  record(channelId:string,turn:Turn,context:ConversationContext,ownerId:string,now:number):void {
    if(likelySecret(turn.text)) return;
    const c=this.channel(channelId,now);
    if(c.rejected.has(turn.id)) return;
    c.turns=c.turns.filter(r=>r.turn.id!==turn.id);
    c.turns.push({turn:clean(turn),conversationId:context.conversationId,ownerId,addressedToOther:context.addressedToOther});
    c.turns.sort((a,b)=>a.turn.at-b.turn.at);
    c.turns=c.turns.slice(-CACHE_TURNS);
  }
  select(event:Event,now:number,resetAt=0):Selection {
    const c=this.channel(event.channelId,now);
    const rows=c.turns.filter(r=>r.turn.at<=event.at && r.turn.at>resetAt && !c.rejected.has(r.turn.id));
    const byId=new Map(rows.map(r=>[r.turn.id,r]));
    const chain:Turn[]=[];
    let expected=event.replyTo;
    let childAt=event.at;
    const seen=new Set([event.id]);
    let status=event.replyChainStatus ?? (event.replyTo?'missing':'none');
    // An explicit fetch failure must not resurrect a deleted/forbidden target from cache.
    const supplied=event.replyChain !== undefined;
    const candidates: ReplyChainTurn[] = supplied ? event.replyChain!.slice(0,3) : [];
    for(let depth=0;expected && depth<3;depth++) {
      const node=supplied ? candidates[depth] : byId.get(expected)?.turn;
      if(!node) break;
      if(node.id!==expected || seen.has(node.id) || node.at>childAt || node.at<=resetAt ||
          (supplied && (node as ReplyChainTurn).channelId!==event.channelId) || likelySecret(node.text) || c.rejected.has(node.id)) {
        status='blocked';break;
      }
      chain.push(clean(node));seen.add(node.id);childAt=node.at;expected=node.replyTo;
      if(!supplied) status=expected?'limited':'complete';
    }
    const target=chain[0];
    const mentionedOthers=(event.mentionedUserIds ?? []).filter(id=>id!==event.userId);
    const lastForSpeaker=[...rows].reverse().find(r=>r.ownerId===event.userId && event.at-r.turn.at<CONTINUE_MS);
    let source:ConversationContext['source']='new';
    let conversationId=`${event.channelId}:message:${event.id}`;
    let addressedToOther=!event.direct && Boolean(target && !target.isBot);
    if(!event.direct && mentionedOthers.length) addressedToOther=true;
    if(event.replyTo) {
      source='reply-chain';
      conversationId=chain.map(t=>byId.get(t.id)?.conversationId).find(Boolean) ?? `${event.channelId}:reply:${chain.at(-1)?.id ?? event.replyTo}`;
    } else if(event.isDm) {
      source='dm';conversationId=`${event.channelId}:dm`;
    } else if(lastForSpeaker && !mentionedOthers.length && !(event.direct && lastForSpeaker.addressedToOther)) {
      source='speaker-continuation';conversationId=lastForSpeaker.conversationId;
      addressedToOther=!event.direct && lastForSpeaker.addressedToOther;
    }
    const related=rows.filter(r=>r.conversationId===conversationId && now-r.turn.at<HISTORY_MS && r.turn.id!==event.id &&
      // Explicitly replying to an older branch must not import later sibling discussions.
      (!event.replyTo || Boolean(target && r.turn.at<=target.at && r.ownerId===event.userId)));
    const picked=new Map<string,Turn>();
    let remaining=6_000;
    // Give the immediate reply target first claim on the text budget, even when old.
    for(const turn of [...chain,...related.map(r=>r.turn).reverse()]) {
      if(picked.has(turn.id) || picked.size>=10 || remaining<=0) continue;
      const bounded={...clean(turn),text:turn.text.slice(0,Math.min(1000,remaining))};
      picked.set(turn.id,bounded);remaining-=bounded.text.length;
    }
    const history=[...picked.values()].sort((a,b)=>a.at-b.at);
    const ambient=event.isDm ? [] : rows.filter(r=>!picked.has(r.turn.id) && r.conversationId!==conversationId && now-r.turn.at<2*60_000)
      .slice(-3).map(r=>({...clean(r.turn),text:r.turn.text.slice(0,220)}));
    return {history,context:{conversationId,source,replyTargetId:event.replyTo,replyTargetUserId:target?.speakerId,
      replyChainIds:chain.map(t=>t.id),replyStatus:status,addressedToOther,
      participantIds:[...new Set([event.userId,...history.map(t=>t.speakerId)])],ambient,now}};
  }
}

/** Keep fetched transport payloads out of prompts; only the validated selection is evidence. */
export function currentEvent(event:Event):Omit<Event,'replyChain'> {
  const {replyChain:_transportOnly,...current}=event;
  return current;
}
