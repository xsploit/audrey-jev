import type { Backend, Config, Event, Evaluation, EvaluationInput, Receipt, Signals, Turn } from './types.js';
import { Store, decayMood, nudgeMood } from './state.js';
import { decayDrives, nudgeDrives, spendSocialBattery } from './drives.js';
import { Duplicates, likelySecret, replyDecision, SerialQueue, WindowBudget } from './policy.js';
import { ConversationTracker, currentEvent } from './conversation.js';
import { compileExpression } from './expression.js';
import { failureInfo } from './escape-diagnostics.js';

export class Engine {
  readonly startedAt: number;
  readonly activity = new Map<string,{id:string;stage:string;at:number}>();
  readonly queue = new SerialQueue(10);
  readonly history = new Map<string, Turn[]>(); // Small accepted-turn view for local diagnostics.
  readonly conversations = new ConversationTracker();
  readonly receipts = new Map<string, Receipt[]>();
  private readonly duplicates = new Duplicates();
  private readonly lastReply = new Map<string, number>();
  private readonly revisions = new Map<string, number>();
  private readonly hourly: WindowBudget;
  private readonly minute: WindowBudget;
  private readonly writers = new WindowBudget(20, 3_600_000);
  diagnostics(channelId:string) {
    const now=this.clock();
    return {startedAt:this.startedAt,activity:this.activity.get(channelId),queued:this.queue.pending,
      cooldownUntil:(this.lastReply.get(channelId) ?? 0)+this.config.cooldownMs,
      budgets:{evaluations:this.hourly.snapshot(now),calls:this.minute.snapshot(now),writers:this.writers.snapshot(now)}};
  }
  recordSkip(event:Event,reason:string):Receipt {
    return this.receipt({id:event.id,channelId:event.channelId,at:event.at,startedAt:this.clock(),trigger:this.trigger(event),action:'quiet',reason});
  }
  private trigger(event:Event):NonNullable<Receipt['trigger']> {
    return event.autonomous?'autonomous':event.isDm?'dm':event.mentioned?'mention':event.direct&&event.replyTo?'reply':event.direct?'direct':'passive';
  }
  constructor(readonly config: Config, readonly store: Store, readonly backend: Backend, readonly clock = Date.now) {
    this.startedAt=this.clock();
    this.hourly = new WindowBudget(config.maxEvaluationsPerHour, 3_600_000);
    this.minute = new WindowBudget(config.maxCallsPerMinute, 60_000);
  }
  private revision(event: Event): number { return this.revisions.get(event.channelId) ?? 0; }
  forgetUser(channelId: string, userId: string): void {
    // Invalidate ALL in-flight/queued turns in this channel: anyone's context can reference this user.
    const key = channelId;
    this.revisions.set(key, (this.revisions.get(key) ?? 0) + 1);
    if (this.config.defaultMemoryUserIds?.includes(userId)) {
      // Preserve only an OFF preference so a default cannot silently re-enable memory after forgetting.
      this.store.channel(channelId).users[userId] = {enabled:false,approved:[],pending:[]};
    } else delete this.store.channel(channelId).users[userId];
    // Clear the entire channel window: bot replies may refer to that user's facts.
    this.history.delete(channelId);
    this.conversations.clear(channelId);
    this.store.channel(channelId).contextResetAt = this.clock();
    this.receipts.delete(channelId);
    this.activity.delete(channelId);
    this.store.save();
  }
  submit(event: Event, send: (text: string, stillAllowed: () => boolean) => Promise<Turn>): Promise<Receipt> {
    const revision = this.revision(event);
    return this.queue.add(async () => {
      try {return await this.process(event,send,revision);}
      catch(error) {return this.receipt({id:event.id,channelId:event.channelId,at:event.at,trigger:this.trigger(event),action:'quiet',reason:'runtime-error',failure:{stage:this.activity.get(event.channelId)?.stage ?? 'runtime',...failureInfo(error)}});}
    }).catch(()=>this.recordSkip(event,'queue-full'));
  }
  private rememberTurn(channel: string, turn: Turn): void {
    const recent = (this.history.get(channel) ?? []).filter(t => this.clock() - t.at < 15 * 60_000);
    this.history.set(channel, [...recent, { ...turn, text: turn.text.slice(0, 500) }].slice(-8));
  }
  private receipt(receipt: Receipt): Receipt {
    receipt.finishedAt=this.clock();
    if(this.activity.get(receipt.channelId)?.id===receipt.id) this.activity.delete(receipt.channelId);
    this.receipts.set(receipt.channelId, [...(this.receipts.get(receipt.channelId) ?? []), receipt].slice(-50));
    return receipt;
  }
  async process(event: Event, send: (text: string, stillAllowed: () => boolean) => Promise<Turn>, revision = this.revision(event)): Promise<Receipt> {
    const base = { id: event.id, channelId: event.channelId, at:event.at, startedAt:this.clock(), trigger:this.trigger(event) };
    const skip = (reason: string) => this.receipt({ ...base, action: 'quiet', reason });
    const now = this.clock();
    this.activity.set(event.channelId,{id:event.id,stage:'checking',at:now});
    const channel = this.store.channel(event.channelId, now);
    if (channel.paused) return skip('paused');
    if (revision !== this.revision(event)) return skip('privacy-changed');
    if (event.at <= (channel.contextResetAt ?? 0)) return skip('before-context-reset');
    if (now - event.at > 45_000) return skip('stale-queue');
    if (!event.text.trim() || event.text.length > 2_000) return skip('empty-or-too-long');
    if (likelySecret(event.text)) return skip('possible-credential');
    if (this.duplicates.check(event, now)) return skip('exact-duplicate');
    const selection = this.conversations.select(event,now,channel.contextResetAt);
    if(event.autonomous) {
      if(!this.config.allowProactive) return skip('autonomy-disabled');
      selection.history=(this.history.get(event.channelId) ?? []).filter(t=>now-t.at<15*60_000 && t.at>(channel.contextResetAt ?? 0));
      if(!selection.history.some(t=>!t.isBot)) return skip('no-recent-human-context');
      selection.context.ambient=[];
    }
    const promptEvent = {...currentEvent(event), addressedToOther:selection.context.addressedToOther};
    const currentTurn: Turn = {id:event.id,speakerId:event.userId,speaker:event.displayName,text:event.text,isBot:false,at:event.at,replyTo:event.replyTo};
    // Observe eligible text even if a model budget/error prevents a reply. All evidence is untrusted.
    if(!event.autonomous) this.conversations.record(event.channelId,currentTurn,selection.context,event.userId,now);
    const direct=event.direct && !event.autonomous;
    // Reserve the final call slot for the writer on explicit direct requests.
    const canEvaluate=this.hourly.available(now) && this.minute.snapshot(now).remaining>(direct?1:0);
    if(!canEvaluate && !direct)return skip('evaluation-budget');
    const input: EvaluationInput = { botName: this.config.botName, interests: this.config.interests, event:promptEvent,
      history: selection.history, context:selection.context,
      mood: decayMood(channel.mood, now), drives: decayDrives(channel.drives,now),
      memories: event.autonomous || this.config.memoryEnabled === false ? [] : this.store.candidates(event.channelId, event.userId) };
    let evaluation:Evaluation|undefined;
    let attempts=0;
    let recoveredFailure:Receipt['recoveredFailure'];
    let failure:Receipt['failure'];
    if(canEvaluate) {
      this.hourly.take(now);this.minute.take(now);attempts=1;
      this.activity.set(event.channelId,{id:event.id,stage:'Jev evaluating',at:this.clock()});
      try {evaluation=await this.backend.evaluate(input);}
      catch(error) {
        failure={stage:'Jev',...failureInfo(error)};
        const retryable=failure.category==='timeout'||failure.category==='rate_limit'||(failure.status ?? 0)>=500;
        // Direct requests go straight to the writer on failure; only unsolicited turns wait for a retry.
        if(!direct && retryable && this.hourly.available(this.clock()) && this.minute.available(this.clock())) {
          this.activity.set(event.channelId,{id:event.id,stage:'Jev retrying transient failure',at:this.clock()});
          await new Promise(r=>setTimeout(r,350));
          if(channel.paused || revision!==this.revision(event))return skip('paused-or-privacy-changed');
          this.hourly.take(this.clock());this.minute.take(this.clock());attempts=2;
          try {evaluation=await this.backend.evaluate(input);recoveredFailure={category:failure.category,status:failure.status};failure=undefined;}
          catch(retryError) {failure={stage:'Jev',...failureInfo(retryError)};}
        }
        if(!direct && !evaluation)return this.receipt({...base,action:'quiet',reason:'evaluation-error',evaluationAttempts:attempts,failure});
      }
    }
    if (channel.paused || revision !== this.revision(event)) return skip('paused-or-privacy-changed');
    const stateFallback:Receipt['stateFallback']=evaluation?undefined:canEvaluate?'jev-error':'jev-budget';
    // Local defaults are never reported as Jev judgments or used to approve memories/tools.
    const signals:Signals = evaluation?.signals ?? {spam:0,addressed:1,opportunity:0,answered:0,interest:0,
      memory:0,selfFact:0,...input.mood,reaction:'neutral',memoryRelevance:{},toolIntent:0};
    const lastReply = this.lastReply.get(event.channelId);
    const cooldownMs = event.isDm ? 2_000 : this.config.cooldownMs;
    const reason = replyDecision(promptEvent, signals, this.config, lastReply !== undefined && this.clock() - lastReply < cooldownMs);
    const receipt: Receipt = { ...base, action: 'quiet', reason, evaluation,
      evaluationAttempts:attempts,recoveredFailure,stateFallback,failure,
      timings:{evaluation:evaluation?.ms},
      context:{source:selection.context.source,conversationId:selection.context.conversationId,
        historyCount:selection.history.length,ambientCount:selection.context.ambient.length,replyStatus:selection.context.replyStatus} };
    // Remove classified spam from the provisional structural cache as well.
    if (signals.spam >= 0.6 && !direct) { this.conversations.reject(event.channelId,event.id,now); return this.receipt(receipt); }
    channel.mood = stateFallback || event.autonomous || this.config.moodEnabled === false ? decayMood(channel.mood,this.clock()) : nudgeMood(channel.mood, signals, this.clock());
    channel.drives = stateFallback || event.autonomous || this.config.moodEnabled === false ? decayDrives(channel.drives,this.clock()) : nudgeDrives(channel.drives,signals,this.clock());
    receipt.mood = { ...channel.mood };
    receipt.expression=compileExpression({...input,mood:channel.mood,drives:channel.drives},signals);
    if (!event.autonomous && this.config.memoryEnabled !== false && this.config.defaultMemoryUserIds?.includes(event.userId) && !channel.users[event.userId]) {
      this.store.user(event.channelId,event.userId).enabled = true;
    }
    const user = channel.users[event.userId];
    // Moderate memorability creates a REVIEW item, never an automatically trusted fact.
    if (!event.autonomous && signals.spam<0.6 && this.config.memoryEnabled !== false && user?.enabled && signals.memory >= 0.55 && signals.selfFact >= 0.9 && event.text.length <= 500 &&
        ![...user.pending, ...user.approved].some(m => m.text === event.text)) {
      user.pending = [...user.pending, { id: event.id, text: event.text, createdAt: now }].slice(-10);
      receipt.memoryProposed = true;
    }
    this.store.save();
    if(!event.autonomous) this.rememberTurn(event.channelId, { id: event.id, speakerId: event.userId, speaker: event.displayName,
      text: event.text, isBot: false, at: now, replyTo: event.replyTo });
    if (reason !== 'reply') return this.receipt(receipt);
    if (this.config.dryRun) return this.receipt({ ...receipt, action: 'would-reply', reason: 'dry-run' });
    const currentMemories = event.autonomous || this.config.memoryEnabled === false ? [] : this.store.candidates(event.channelId, event.userId);
    const memories = currentMemories.filter(m => (signals.memoryRelevance[m.id] ?? 0) >= 0.65)
      .sort((a,b) => (signals.memoryRelevance[b.id] ?? 0) - (signals.memoryRelevance[a.id] ?? 0)).slice(0,3);
    receipt.selectedMemoryCount=memories.length;
    let text;
    try {
      if (this.backend.write) {
        if (!this.writers.available(this.clock()) || !this.minute.available(this.clock())) return this.receipt({ ...receipt, reason: 'writer-budget' });
        this.writers.take(this.clock()); this.minute.take(this.clock());
        this.activity.set(event.channelId,{id:event.id,stage:'writer generating',at:this.clock()});
        const writerAt=this.clock();
        receipt.writerStarted=true;
        text = await this.backend.write({ ...input, mood: { ...channel.mood }, drives: channel.drives }, signals, memories);
        receipt.timings!.writer=this.clock()-writerAt;
      } else {
        text = `[Audrey diagnostic mode] I'd reply here. Reaction: ${signals.reaction}. Set WRITER_MODEL for conversational replies.`;
      }
    } catch(error) { return this.receipt({ ...receipt, reason: 'writer-error',failure:{stage:'writer',...failureInfo(error)} }); }
    if (channel.paused || revision !== this.revision(event)) return this.receipt({ ...receipt, reason: 'paused-or-privacy-changed' });
    if (this.config.dryRun) return this.receipt({ ...receipt, action:'would-reply', reason:'dry-run' });
    if (!text.trim() || likelySecret(text)) return this.receipt({ ...receipt, reason: 'empty-or-sensitive-output' });
    const reply = text.slice(0, 1_800);
    let sent;
    this.activity.set(event.channelId,{id:event.id,stage:'Discord delivery',at:this.clock()});
    const deliveryAt=this.clock();
    try { sent = await send(reply,()=>!channel.paused && !this.config.dryRun && revision === this.revision(event)); }
    catch(error) { return this.receipt({ ...receipt, reason: 'send-error',failure:{stage:'Discord delivery',...failureInfo(error)} }); }
    receipt.timings!.delivery=this.clock()-deliveryAt;
    this.lastReply.set(event.channelId, this.clock());
    this.rememberTurn(event.channelId, sent);
    if(!event.autonomous) this.conversations.record(event.channelId,{...sent,replyTo:event.id},selection.context,event.userId,this.clock());
    try {
      if (channel.drives && this.config.moodEnabled !== false) { channel.drives = spendSocialBattery(channel.drives); this.store.save(); }
    } catch { return this.receipt({ ...receipt, action:'replied', reason:'replied-but-state-save-failed',reply }); }
    return this.receipt({ ...receipt, action: 'replied', reply });
  }
}
