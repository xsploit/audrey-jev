import { likelySecret } from './policy.js';
import type { ReplyChainTurn, ReplyStatus } from './types.js';
export interface ReplyNode { turn: ReplyChainTurn; parentChannelId?: string; isForward?: boolean }
export interface ReplyChainResult { turns: ReplyChainTurn[]; status: ReplyStatus }

/** Fetch only explicitly linked ancestors in the SAME channel; never enumerate history. */
export async function loadReplyChain(input: {
  channelId: string; messageId: string; replyTo?: string; referenceChannelId?: string;
  currentAt: number; maxDepth?: number; timeoutMs?: number;
  fetch: (id: string) => Promise<ReplyNode | null>;
  allowed?: (turn: ReplyChainTurn) => boolean;
}): Promise<ReplyChainResult> {
  if (!input.replyTo) return {turns:[],status:'none'};
  if (input.referenceChannelId && input.referenceChannelId !== input.channelId) return {turns:[],status:'blocked'};
  const turns: ReplyChainTurn[]=[];
  const seen=new Set([input.messageId]);
  const deadline=Date.now()+(input.timeoutMs ?? 2_500);
  let next: string | undefined=input.replyTo;
  let childAt=input.currentAt;
  const maxDepth=Math.min(3,Math.max(1,input.maxDepth ?? 3));
  while(next && turns.length<maxDepth) {
    if(seen.has(next)) return {turns,status:'blocked'};
    seen.add(next);
    const remaining=deadline-Date.now();
    if(remaining<=0) return {turns,status:'limited'};
    let timer: ReturnType<typeof setTimeout> | undefined;
    let node: ReplyNode | null | undefined;
    try {
      node=await Promise.race([
        input.fetch(next),
        new Promise<undefined>(resolve=>{timer=setTimeout(()=>resolve(undefined),remaining);}),
      ]);
    } catch { return {turns,status:'missing'}; }
    finally { if(timer) clearTimeout(timer); }
    if(node===undefined) return {turns,status:'limited'};
    if(!node) return {turns,status:'missing'};
    const turn: ReplyChainTurn=node.turn;
    if(turn.id!==next || turn.channelId!==input.channelId || !Number.isFinite(turn.at) || turn.at>childAt ||
        likelySecret(turn.text) || (input.allowed && !input.allowed(turn))) return {turns,status:'blocked'};
    turns.push({...turn,text:turn.text.slice(0,1_000),speaker:turn.speaker.slice(0,80)});
    if(node.isForward || (node.parentChannelId && node.parentChannelId!==input.channelId)) return {turns,status:'blocked'};
    next=turn.replyTo;childAt=turn.at;
  }
  return {turns,status:next?'limited':'complete'};
}
