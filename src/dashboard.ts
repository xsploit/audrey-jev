import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, MessageFlags, PermissionFlagsBits,
  StringSelectMenuBuilder, TextDisplayBuilder, type Client, type Interaction } from 'discord.js';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { Engine } from './engine.js';
import type { Receipt } from './types.js';
import type { AutonomousClock } from './autonomy.js';
import { decayMood } from './state.js';
import { decayDrives } from './drives.js';
import { generationSettings } from './expression.js';
import { failureInfo } from './escape-diagnostics.js';
import { WindowBudget } from './policy.js';

export const VIEWS=['overview','emotions','decisions','prompt'] as const;
type View=typeof VIEWS[number];
export interface Panel { channelId:string; messageId:string; guildId:string; view:View; selected?:string }
const snowflake=z.string().regex(/^\d{17,20}$/);
const panelSchema=z.object({channelId:snowflake,messageId:snowflake,guildId:snowflake,view:z.enum(VIEWS),selected:z.string().max(100).optional()});
const mentions={parse:[] as [],repliedUser:false};
const safe=(s:string)=>s.replace(/[`@<>\[\]\\]/g,'').slice(0,120);
const percent=(n:number)=>`${Math.round(n*100)}%`;
const bar=(n:number)=>{const v=Math.round(Math.min(1,Math.max(0,n))*10);return `${'▰'.repeat(v)}${'▱'.repeat(10-v)} ${percent(n)}`;};
const stamp=(at:number,style='T')=>`<t:${Math.floor(at/1000)}:${style}>`;
export function decisionLabel(r:Receipt):string {
  if(r.action==='replied' && r.stateFallback)return 'SENT · STATE FALLBACK';
  if(r.noticeSent)return 'ERROR · NOTICE SENT';
  if(r.action==='replied') return r.reason==='replied-but-state-save-failed'?'SENT · state save failed':'SENT';
  if(r.failure || /error|failed|queue-full/.test(r.reason)) return 'ERROR';
  if(r.action==='would-reply') return 'DRY RUN';
  if(['not-invited','autonomous-quiet','already-answered','spam','addressed-to-someone-else'].includes(r.reason)) return 'JEV / POLICY SILENCE';
  return 'SYSTEM BLOCK';
}
export function reasonText(r:Receipt):string {
  const reasons:Record<string,string>={
    reply:r.stateFallback?'Direct reply sent using current state; Jev styling was unavailable.':r.trigger==='mention'?'Direct @mention accepted without a response gate.':r.trigger==='autonomous'?'Jev approved an idle contribution.':'Reply accepted.',
    cooldown:'Passive reply cooldown was still active. Direct requests bypass it.',
    'already-answered':'Jev scored this passive question as already answered (≥90%). Direct requests bypass this gate.',
    spam:'Jev spam score reached the 60% blocking threshold.',
    'not-invited':'No direct invitation, and the proactive thresholds were not met.',
    'autonomous-quiet':'Idle opportunity did not meet welcome ≥85% and interest ≥55%.',
    'addressed-to-someone-else':'Context identified an exchange with another person.',
    'evaluation-budget':'The shared Jev/hour or call/minute budget was exhausted.',
    'writer-budget':'The shared writer/hour or call/minute budget was exhausted.',
    'evaluation-error':`Jev did not return a usable decision after ${r.evaluationAttempts ?? 1} attempt(s). No writer call was made.${r.noticeSent?' A service-error notice was delivered.':''}`,
    'writer-error':'The writer failed; no reply was delivered.',
    'send-error':'Discord delivery failed or the pending send was cancelled.',
    'runtime-error':'Runtime/storage failure interrupted the turn.',
    'queue-full':'The processing queue was full.',
    paused:'This channel is paused.', 'dry-run':'Jev approved replying, but dry mode prevented generation and delivery.',
    'possible-credential':'Possible credential detected; message was not sent to a model.',
    'exact-duplicate':'Duplicate text within the last minute; no new model request.',
    'no-recent-human-context':'No recent human context is available for initiation.',
    'empty-or-too-long':'Input was empty or exceeded the 2,000-character limit.',
    'stale-queue':'Message spent too long waiting in the queue.',
    'empty-or-sensitive-output':'The generated reply was empty or contained a possible credential.',
    'attachments-only':'No text to evaluate; attachment understanding is unavailable.',
    'paused-or-privacy-changed':'Pause or forgetting cancelled this turn.',
    'privacy-changed':'Forgetting invalidated this queued turn.',
    'before-context-reset':'Message predates the last context reset.',
    'autonomy-disabled':'Autonomous participation is disabled.',
  };
  return reasons[r.reason] ?? safe(r.reason);
}
const card=(text:string,color:number)=>new ContainerBuilder().setAccentColor(color).addTextDisplayComponents(new TextDisplayBuilder().setContent(text));
const button=(id:string,label:string,active=false)=>new ButtonBuilder().setCustomId(`audreydash:${id}`).setLabel(label).setStyle(active?ButtonStyle.Primary:ButtonStyle.Secondary);

export function renderDashboard(engine:Engine, autonomy:AutonomousClock, panel:Panel, model:string, online=true) {
  const now=engine.clock(), channel=engine.store.channel(panel.channelId), diag=engine.diagnostics(panel.channelId);
  const receipts=engine.receipts.get(panel.channelId) ?? [];
  const selected=panel.selected?receipts.find(r=>r.id===panel.selected):receipts.at(-1);
  const mood=decayMood(channel.mood,now), drives=decayDrives(channel.drives,now);
  const auto=autonomy.status(panel.channelId,now);
  const autoText=!engine.config.allowProactive?'disabled':channel.paused?'channel paused':engine.config.dryRun?'dry mode':
    auto.state==='scheduled'?`next opportunity ${stamp(auto.dueAt!,'R')} (checked each minute)`:
    auto.state==='opportunity-consumed'?'checked this pause; waiting for another human turn':'waiting for a recent human turn';
  const header=card(`# 🧪 AUDREY · EXPERIMENT CENTER\n${online?'🟢 Connected':'🔴 Disconnected'} · **${engine.config.dryRun?'DRY RUN':'LIVE'}** · ${channel.paused?'⏸ Paused':'Listening'}\n`+
    `Jev → **${safe(model)||'diagnostic writer'}**\n`+
    `**Now:** ${diag.activity?safe(diag.activity.stage):'idle'} · queue ${diag.queued}/10\n`+
    `Updated ${stamp(now)} · session ${stamp(diag.startedAt,'R')}\n-# Auto-refresh every 10s. If the update time stops advancing, this panel is stale.`,online?0x65d7b0:0xe76c79);
  header.addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(...VIEWS.map(v=>button(v,v[0]!.toUpperCase()+v.slice(1),v===panel.view))));
  const parts=[header];
  const summary=selected?`**${decisionLabel(selected)}** · ${selected.trigger ?? 'event'} · ${stamp(selected.finishedAt ?? now)}\n${reasonText(selected)}${selected.recoveredFailure?`\nRecovered on retry from ${safe(selected.recoveredFailure.category)} ${selected.recoveredFailure.status ?? ''}.`:''}${selected.failure?`\nFailure: **${safe(selected.failure.stage)} / ${safe(selected.failure.category)}${selected.failure.status?` (${selected.failure.status})`:''}**`:''}`:
    panel.selected?'That event was cleared or expired. Choose Latest live event.':'No decisions in this channel since startup. Mention Audrey to produce a real trace.';
  if(panel.view==='overview') {
    parts.push(card(`## Latest outcome\n${summary}\n\n**Expression:** ${selected?.expression?.active.join(' · ') || 'none selected'}\n`+
      `**Behavior:** ${selected?.expression?.behavior ?? '—'} · **Pace:** ${selected?.expression?.pace ?? '—'}\n`+
      `**Timing:** Jev ${selected?.timings?.evaluation ?? '—'}ms · writer ${selected?.timings?.writer ?? '—'}ms · delivery ${selected?.timings?.delivery ?? '—'}ms`,0x9e8dff));
    parts.push(card(`## Internal state\nValence　\`${bar(mood.valence)}\`\nArousal　\`${bar(mood.arousal)}\`\nComposure \`${bar(mood.dominance)}\`\n`+
      `Curiosity \`${bar(drives.curiosity)}\`\nBattery　\`${bar(drives.socialBattery)}\`\nTension　\`${bar(drives.tension)}\`\n\n**Autonomy:** ${autoText}\n`+
      `**Cooldown:** ${diag.cooldownUntil>now?`${Math.ceil((diag.cooldownUntil-now)/1000)}s remaining`:'ready'}`,0xf2b86c));
    const b=diag.budgets;
    parts.push(card(`## Shared experiment budgets\nJev evaluations **${b.evaluations.used}/${b.evaluations.limit} per hour** · writers **${b.writers.used}/${b.writers.limit} per hour**\n`+
      `Turn admissions **${b.calls.used}/${b.calls.limit} per minute**\n-# Writer admissions can contain up to 3 SDK generation steps. Counters reset on process restart; these are not billing totals.`,0x72b9e8));
  } else if(panel.view==='emotions') {
    const scores=selected?.evaluation?.signals.expression?.emotions;
    parts.push(card(`## Jev emotion matches\n${scores?Object.entries(scores).sort((a,b)=>b[1]!-a[1]!).map(([name,p])=>`${selected?.expression?.active.includes(name as never)?'◆':'◇'} **${name}** \`${bar(p!)}\``).join('\n'):'Waiting for an evaluated event.'}\n\n`+
      `◆ = selected for the compiled expression. Threshold 60%, strongest 3, conflict resolution applied.\nThese are Jev match scores, not measured human emotions or calibrated certainty.`,0xd399ea));
    parts.push(card(`## Expression choices\n${summary}\n\nBehavior **${selected?.expression?.behavior ?? '—'}** · pace **${selected?.expression?.pace ?? '—'}**\n`+
      `Creativity **${selected?.evaluation?.signals.expression?.creativity ?? '—'}** · reasoning **${selected?.evaluation?.signals.expression?.reasoning ?? '—'}**\n-# Selected cues only reach the writer if generation actually starts.`,0x9e8dff));
  } else if(panel.view==='decisions') {
    const s=selected?.evaluation?.signals;
    parts.push(card(`## Why this happened\n${summary}\n\n${s?
      `Addressed **${percent(s.addressed)}** · welcome **${percent(s.opportunity)}** · interest **${percent(s.interest)}**\nAlready answered **${percent(s.answered)}** · spam **${percent(s.spam)}**\n`+
      `Context: **${selected?.context?.historyCount ?? 0}** conversation turns · **${selected?.context?.ambientCount ?? 0}** ambient · reply chain **${selected?.context?.replyStatus ?? 'none'}**`:'No Jev scores for this event.'}\n\n`+
      `**Direct policy:** @mentions, replies to Audrey and DMs bypass response scoring and cooldown. Jev only supplies style; a Jev outage uses current state. Pause, dry mode and writer resource limits still apply.\n**Passive:** welcome ≥90% + interest ≥65%. **Idle:** welcome ≥85% + interest ≥55%.`,0x72b9e8));
    parts.push(card(`## Recent channel decisions\n${receipts.slice(-6).reverse().map(r=>{
      const link=/^\d{17,20}$/.test(r.id)?`[message](https://discord.com/channels/${panel.guildId}/${panel.channelId}/${r.id})`:'idle tick';
      return `${stamp(r.finishedAt ?? now)} · **${decisionLabel(r)}** · ${r.trigger ?? 'event'} · ${link}\n↳ ${safe(r.reason)}`;
    }).join('\n') || 'No events yet.'}\n-# Last 50 events retained in memory per channel. Forget clears the trace. No message bodies or private memories are published here.`,0x9e8dff));
  } else {
    const settings=generationSettings(model,selected?.evaluation?.signals.expression);
    parts.push(card(`## Compiled expression\n**${selected?.writerStarted?'Writer was invoked with this expression':'Preview only — writer was not invoked'}**\n`+
      `${selected?.expression?.text ?? 'No compiled expression for this event.'}`,0xd399ea));
    parts.push(card(`## Generation controls\n${selected?.evaluation || selected?.writerStarted ?
      `Model **${safe(model)}**\nOutput budget **${settings.maxOutputTokens} tokens** · temperature **${settings.temperature ?? 'provider default'}**\nThinking **${settings.providerOptions?.google.thinkingConfig.thinkingLevel ?? 'provider default'}**\nSelected approved memories **${selected.selectedMemoryCount ?? 0}**\n${selected.evaluation?`Jev usage **${selected.evaluation.inputTokens} input / ${selected.evaluation.outputTokens} output tokens**`:'Current-state fallback; no Jev scores available.'}`:
      'Waiting for a Jev evaluation.'}\n-# Only the dynamic expression is displayed. Conversation text, personal memory contents, credentials and hidden reasoning are excluded.`,0x72b9e8));
  }
  const footer=card(`### Experiment controls\nPause applies to this channel. Autonomy applies to the whole bot, requires the owner, and resets to .env on restart.`,0x3c4358);
  if(receipts.length) footer.addActionRowComponents(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder()
    .setCustomId('audreydash:event').setPlaceholder(panel.selected?'Inspecting a past event':'Following latest live event').addOptions(
      {label:'Latest live event',value:'latest',default:!panel.selected},
      ...[...new Map(receipts.map(r=>[r.id,r])).values()].slice(-10).reverse().map(r=>({label:`${new Date(r.finishedAt ?? now).toISOString().slice(11,19)} · ${r.trigger ?? 'event'} · ${r.reason}`.slice(0,100),value:r.id,default:panel.selected===r.id})))));
  footer.addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(button('refresh','Refresh'),
    button(channel.paused?'resume':'pause',channel.paused?'Resume channel':'Pause channel'),
    button(engine.config.allowProactive?'auto-off':'auto-on',`Autonomy: ${engine.config.allowProactive?'ON':'OFF'} (global)`)));
  parts.push(footer);
  return {flags:MessageFlags.IsComponentsV2 as const,components:parts,allowedMentions:mentions};
}

export class Dashboard {
  readonly panels=new Map<string,Panel>();
  private pending=new Map<string,Promise<unknown>>();
  private timer?:ReturnType<typeof setInterval>;
  private interactions=new WindowBudget(60,60_000);
  constructor(readonly client:Client,readonly engine:Engine,readonly autonomy:AutonomousClock,readonly model:string,
    readonly file:string,readonly ownerId:string,readonly allowed:(guildId:string,channelId:string)=>boolean) {
    if(existsSync(file)) for(const panel of z.array(panelSchema).max(10).parse(JSON.parse(readFileSync(file,'utf8')))) this.panels.set(panel.channelId,panel);
  }
  private save() {
    mkdirSync(dirname(this.file),{recursive:true,mode:0o700});
    writeFileSync(`${this.file}.tmp`,JSON.stringify([...this.panels.values()]),{mode:0o600});renameSync(`${this.file}.tmp`,this.file);
  }
  private serial<T>(channelId:string,work:()=>Promise<T>):Promise<T> {
    const task=(this.pending.get(channelId) ?? Promise.resolve()).catch(()=>{}).then(work);
    this.pending.set(channelId,task);
    void task.finally(()=>{if(this.pending.get(channelId)===task)this.pending.delete(channelId);}).catch(()=>{});
    return task;
  }
  async open(channelId:string):Promise<string> {
    return this.serial(channelId,async()=>{
      const channel=await this.client.channels.fetch(channelId);
      if(!channel || !channel.isSendable() || channel.isDMBased() || !('guildId' in channel) || !this.allowed(channel.guildId,channelId)) throw new Error('Dashboard requires an allowed server text channel outside escape sessions.');
      const existing=this.panels.get(channelId);
      if(existing) {
        try {await this.edit(existing);return `https://discord.com/channels/${existing.guildId}/${channelId}/${existing.messageId}`;}
        catch(error) {if((error as {code?:number}).code!==10008)throw error;this.panels.delete(channelId);}
      }
      if(this.panels.size>=10)throw new Error('Dashboard panel limit reached.');
      const panel:Panel={channelId,guildId:channel.guildId,messageId:'0',view:'overview'};
      const message=await channel.send(renderDashboard(this.engine,this.autonomy,panel,this.model,this.client.isReady()));
      panel.messageId=message.id;this.panels.set(channelId,panel);this.save();
      return message.url;
    });
  }
  private async edit(panel:Panel) {
    if(!this.allowed(panel.guildId,panel.channelId))return;
    const channel=await this.client.channels.fetch(panel.channelId);
    if(!channel?.isSendable() || channel.isDMBased() || !('guildId' in channel) || channel.guildId!==panel.guildId)throw new Error('Dashboard channel unavailable');
    const message=await channel.messages.fetch(panel.messageId);
    if(message.author.id!==this.client.user?.id)throw new Error('Dashboard author mismatch');
    await message.edit(renderDashboard(this.engine,this.autonomy,panel,this.model,this.client.isReady()));
  }
  start() {
    if(this.timer)return;
    this.timer=setInterval(()=>{if(!this.client.isReady())return;for(const panel of this.panels.values()) {
      if(this.pending.has(panel.channelId))continue;
      void this.serial(panel.channelId,()=>this.edit(panel)).catch(error=>{
        if((error as {code?:number}).code===10008) {this.panels.delete(panel.channelId);this.save();}
        console.warn(JSON.stringify({event:'dashboard_refresh_failure',...failureInfo(error)}));
      });
    }},10_000);this.timer.unref();
  }
  stop(){if(this.timer)clearInterval(this.timer);this.timer=undefined;}
  async interaction(i:Interaction):Promise<boolean> {
    if(!(i.isButton()||i.isStringSelectMenu()) || !i.customId.startsWith('audreydash:'))return false;
    if(!this.interactions.take(Date.now())) {await i.reply({content:'Dashboard controls are busy; try again in a moment.',flags:MessageFlags.Ephemeral});return true;}
    const panel=this.panels.get(i.channelId);
    if(!panel || panel.messageId!==i.message.id || panel.guildId!==i.guildId || !this.allowed(panel.guildId,panel.channelId)) {
      await i.reply({content:'This panel is no longer active. Run /audrey dashboard again.',flags:MessageFlags.Ephemeral});return true;
    }
    const action=i.customId.slice('audreydash:'.length);
    const owner=i.user.id===this.ownerId;
    if((action==='pause'||action==='resume') && !owner && !i.memberPermissions?.has(PermissionFlagsBits.ManageMessages) ||
      (action==='auto-on'||action==='auto-off') && !owner) {
      await i.reply({content:'Channel pause needs Manage Messages; global autonomy needs the configured bot owner.',flags:MessageFlags.Ephemeral});return true;
    }
    await i.deferUpdate();
    await this.serial(panel.channelId,async()=>{
      if(VIEWS.includes(action as View))panel.view=action as View;
      else if(action==='event'&&i.isStringSelectMenu()) {
        const id=i.values[0];
        if(id==='latest')delete panel.selected;
        else if(this.engine.receipts.get(panel.channelId)?.some(r=>r.id===id))panel.selected=id;
      } else if(action==='pause'||action==='resume') {this.engine.store.channel(panel.channelId).paused=action==='pause';this.engine.store.save();}
      else if(action==='auto-on'||action==='auto-off')this.engine.config.allowProactive=action==='auto-on';
      this.save();await this.edit(panel);
    });
    return true;
  }
}
