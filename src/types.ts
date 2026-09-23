export type Reaction = 'attentive' | 'celebrate' | 'comfort' | 'surprised' | 'neutral' | 'disapprove';
export interface Mood { valence: number; arousal: number; dominance: number; updatedAt: number }
export interface Memory { id: string; text: string; createdAt: number }
export interface UserMemory { enabled: boolean; approved: Memory[]; pending: Memory[] }
export interface Drives { curiosity: number; socialBattery: number; tension: number; updatedAt: number }
export interface ChannelState { paused: boolean; mood: Mood; drives?: Drives; contextResetAt?: number; users: Record<string, UserMemory> }
export interface StoredState { version: 1; channels: Record<string, ChannelState> }
// isBot means AUDREY, not an arbitrary Discord bot.
export interface Turn { id: string; speakerId: string; speaker: string; text: string; isBot: boolean; isOtherBot?: boolean; at: number; replyTo?: string }
export type ReplyStatus = 'none' | 'complete' | 'missing' | 'limited' | 'blocked';
export interface ReplyChainTurn extends Turn { channelId: string }
export interface ConversationContext {
  conversationId: string;
  source: 'reply-chain' | 'speaker-continuation' | 'dm' | 'new';
  replyTargetId?: string; replyTargetUserId?: string; replyChainIds: string[]; replyStatus: ReplyStatus;
  addressedToOther: boolean; participantIds: string[]; ambient: Turn[]; now: number;
}
export interface Event {
  mentioned?: boolean;
  autonomous?: boolean;
  id: string; channelId: string; userId: string; displayName: string; text: string;
  direct: boolean; replyTo?: string; at: number; isDm?: boolean; canManageTools?: boolean;
  mentionedUserIds?: string[]; replyChain?: ReplyChainTurn[]; replyChainStatus?: ReplyStatus;
  addressedToOther?: boolean;
}
export interface Signals {
  expression?: import('./expression.js').Expression;
  spam: number; addressed: number; opportunity: number; answered: number;
  interest: number; memory: number; selfFact: number;
  valence: number; arousal: number; dominance: number;
  reaction: Reaction; memoryRelevance: Record<string, number>; toolIntent?: number;
}
export interface EvaluationInput {
  botName: string; interests: string; event: Event; history: Turn[];
  mood: Mood; drives?: Drives; memories: Memory[]; context?: ConversationContext;
  fictionalScenario?: string;
}
export interface Evaluation { signals: Signals; inputTokens: number; outputTokens: number; ms: number }
export interface Config {
  botName: string; interests: string; dryRun: boolean; allowProactive: boolean;
  cooldownMs: number; maxEvaluationsPerHour: number; maxCallsPerMinute: number;
  moodEnabled?: boolean; memoryEnabled?: boolean; defaultMemoryUserIds?: string[];
}
export interface Receipt {
  stateFallback?: 'jev-error' | 'jev-budget';
  evaluationAttempts?: number; recoveredFailure?: {category:string;status?:number}; noticeSent?: boolean;
  at?: number; startedAt?: number; finishedAt?: number;
  trigger?: 'mention' | 'reply' | 'dm' | 'direct' | 'passive' | 'autonomous';
  timings?: { evaluation?: number; writer?: number; delivery?: number };
  failure?: { stage: string; category: string; status?: number };
  expression?: ReturnType<typeof import('./expression.js').compileExpression>;
  writerStarted?: boolean; selectedMemoryCount?: number;
  id: string; channelId: string; action: string; reason: string; evaluation?: Evaluation;
  mood?: Mood; memoryProposed?: boolean; reply?: string;
  context?: { source: ConversationContext['source']; conversationId: string; historyCount: number; ambientCount: number; replyStatus: ReplyStatus };
}
export interface Backend {
  evaluate(input: EvaluationInput): Promise<Evaluation>;
  write?(input: EvaluationInput, signals: Signals, memories: Memory[]): Promise<string>;
}
