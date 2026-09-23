import type { Engine } from './engine.js';
import { decayMood } from './state.js';
import { likelySecret } from './policy.js';
import { decayDrives } from './drives.js';
import { compileExpression } from './expression.js';

export const HELP = `I'm Audrey: a Discord companion experiment. Jev handles decisions; Gemini writes replies.
Mention me, reply to me, or DM me. I only passively watch explicitly allowed channels or servers.
Messages I process go to Vercel/TypeSafe and, for replies, the configured writer provider. Don't send secrets. No audio/image understanding yet.
Controls: !audrey dashboard | status | memory on | memory off | memories | approve <message-id> | remember <fact> | forget | diary | help
Dashboard opens a shared, auto-refreshing experiment panel in this server channel (Manage Messages or bot owner). It shows decisions, expression, prompt blocks and budgets without publishing message text or memory contents.
Memory is off unless you opt in or explicitly request it enabled by default. It lets me PROPOSE memories; approve them yourself. Memory is separate per person and channel/DM. "forget" deletes your local memory and clears this channel's short context (not provider logs).
Server slash commands: /audrey. Admins: pause, resume, mode dry/live. Diary is a factual decision trace, not hidden thoughts.
Outreach: DM !audrey outreach on/off to consent/revoke. Admins can propose USER_ID | exact text, inspect outbox, and send <proposal-id>. No automatic unsolicited DMs.`;
export interface ControlContext { channelId: string; userId: string; canManage: boolean; canManageMode: boolean }
export function control(engine: Engine, ctx: ControlContext, command: string, argument = ''): string {
  const channel = engine.store.channel(ctx.channelId);
  if (engine.config.memoryEnabled !== false && engine.config.defaultMemoryUserIds?.includes(ctx.userId) && !channel.users[ctx.userId]) {
    engine.store.user(ctx.channelId,ctx.userId).enabled = true;
    engine.store.save();
  }
  switch (command) {
    case 'help': return HELP;
    case 'status': {
      const mood = decayMood(channel.mood, engine.clock());
      const user = channel.users[ctx.userId];
      const drives = decayDrives(channel.drives,engine.clock());
      const last = engine.receipts.get(ctx.channelId)?.at(-1);
      const selected = last?.evaluation?.signals.expression;
      const expression = selected && last?.evaluation ? compileExpression({botName:engine.config.botName,interests:engine.config.interests,
        event:{id:'status',channelId:ctx.channelId,userId:ctx.userId,displayName:'status',text:'',direct:false,at:engine.clock()},
        mood,drives,memories:[],history:[]},last.evaluation.signals) : undefined;
      const dynamic = `\nAutonomous participation: ${engine.config.allowProactive ? 'on' : 'off'}${expression ? `\nExpression: ${expression.active.join(', ') || 'neutral'} · ${expression.behavior} · ${expression.pace} · thinking ${selected!.reasoning}` : ''}`;
      return `Audrey · ${engine.config.dryRun ? 'DRY RUN (no automatic replies)' : 'LIVE'} · ${channel.paused ? 'paused' : 'listening'}${dynamic}\nVAD (fictional): ${mood.valence.toFixed(2)} / ${mood.arousal.toFixed(2)} / ${mood.dominance.toFixed(2)}\nFictional drives: curiosity ${drives.curiosity.toFixed(2)} · social battery ${drives.socialBattery.toFixed(2)} · tension ${drives.tension.toFixed(2)}\nYour memory: ${user?.enabled ? 'enabled' : 'off'} · ${user?.approved.length ?? 0} approved · ${user?.pending.length ?? 0} pending\nLast decision: ${last?.action ?? 'none'} / ${last?.reason ?? 'none'}${last?.evaluation ? ` · ${last.evaluation.ms}ms · ${last.evaluation.signals.reaction}` : ''}${last?.context ? `\nContext: ${last.context.source} · ${last.context.historyCount} conversation turns · reply chain ${last.context.replyStatus}` : ''}`;
    }
    case 'pause': case 'resume':
      if (!ctx.canManage) return 'Manage Messages permission is required to pause a server channel.';
      channel.paused = command === 'pause'; engine.store.save();
      return channel.paused ? 'Paused this channel.' : 'Resumed this channel.';
    case 'mode':
      if (!ctx.canManageMode) return 'A server manager or the configured owner must change the global runtime mode.';
      if (!['dry','live'].includes(argument)) return 'Use mode dry or mode live.';
      engine.config.dryRun = argument === 'dry';
      return `${argument === 'dry' ? 'Dry-run' : 'Live replies'} enabled for this process. Restart uses DRY_RUN from .env.`;
    case 'memory':
      if (argument === 'off') { engine.forgetUser(ctx.channelId,ctx.userId); return 'Memory disabled; your saved facts and this channel’s short context were cleared locally.'; }
      if (argument !== 'on') return 'Use memory on or memory off.';
      if (engine.config.memoryEnabled === false) return 'Memory is disabled globally by ENABLE_MEMORY=false.';
      engine.store.user(ctx.channelId,ctx.userId).enabled = true; engine.store.save();
      return 'Memory proposals enabled for you in this conversation. Nothing becomes an approved fact until you approve it. View with memories; remove everything with forget.';
    case 'memories': {
      const user = channel.users[ctx.userId];
      const lines = (items: {id: string; text: string}[]) => items.slice(-5).map(m=>`${m.id}: ${m.text.slice(0,120)}`).join('\n') || '(none)';
      return `PENDING (newest five):\n${lines(user?.pending ?? [])}\n\nAPPROVED (newest five):\n${lines(user?.approved ?? [])}\nApprove an ID or use forget to clear all. Never approve an outdated or incorrectly attributed fact.`;
    }
    case 'approve': {
      const user = channel.users[ctx.userId];
      const memory = user?.pending.find(m=>m.id===argument);
      if (!user?.enabled || !memory) return 'No pending memory with that ID belonging to you in this conversation.';
      user.approved = [...user.approved,memory].slice(-30);
      user.pending = user.pending.filter(m=>m.id!==argument); engine.store.save();
      return 'Approved. This exact text—not an invented summary—can now inform replies to you here.';
    }
    case 'remember': {
      if (engine.config.memoryEnabled === false) return 'Memory is disabled globally.';
      if (!argument.trim() || argument.length > 500 || likelySecret(argument)) return 'Supply a non-sensitive fact of 1–500 characters.';
      const user = engine.store.user(ctx.channelId,ctx.userId);
      if (!user.enabled) return 'First enable memory with memory on.';
      const id = `manual-${engine.clock()}`;
      user.approved = [...user.approved,{ id, text: argument, createdAt: engine.clock() }].slice(-30);
      engine.store.save(); return `Saved your explicit memory (${id}). Use forget to clear all before replacing outdated facts.`;
    }
    case 'forget': engine.forgetUser(ctx.channelId,ctx.userId); return 'Your memory is off and cleared locally. The channel’s short context and decision diary were cleared too. This cannot erase provider or Discord logs.';
    case 'diary': {
      const entries = engine.receipts.get(ctx.channelId) ?? [];
      const lines = entries.filter(r=>r.evaluation).slice(-8).map(r=>`• ${r.id}: ${r.action} (${r.reason}); reaction ${r.evaluation!.signals.reaction}; interest ${r.evaluation!.signals.interest.toFixed(2)}${r.memoryProposed ? '; proposed a memory for review' : ''}`);
      return `Session diary — factual decision trace, not private thoughts:\n${lines.join('\n') || '(no evaluated events this session)'}`;
    }
    default: return 'Unknown control. Use !audrey help.';
  }
}
