import { createHash } from 'node:crypto';
import type { Config, Event, Signals } from './types.js';

export function likelySecret(text: string): boolean {
  return /(?:vck_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}|[A-Za-z0-9_-]{23,28}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{25,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/.test(text);
}
export class WindowBudget {
  private times: number[] = [];
  constructor(readonly limit: number, readonly windowMs: number) {}
  available(now: number): boolean {
    this.times = this.times.filter(t => t > now - this.windowMs);
    return this.times.length < this.limit;
  }
  take(now: number): boolean {
    if (!this.available(now)) return false;
    this.times.push(now);
    return true;
  }
  snapshot(now: number) {
    this.available(now);
    return {used:this.times.length,limit:this.limit,remaining:Math.max(0,this.limit-this.times.length),
      nextAvailableAt:this.times.length>=this.limit ? this.times[0]!+this.windowMs : now};
  }
}
export class Duplicates {
  private seen = new Map<string, number>();
  check(event: Event, now: number): boolean {
    for (const [key, t] of this.seen) if (now - t > 60_000) this.seen.delete(key);
    const key = event.direct && !event.autonomous ? `${event.channelId}:direct:${event.id}` : `${event.channelId}:${event.userId}:${createHash('sha256').update(event.text.trim().replace(/\s+/g, ' ')).digest('hex')}`;
    if (this.seen.has(key)) return true;
    if (this.seen.size >= 2_000) this.seen.delete(this.seen.keys().next().value!);
    this.seen.set(key, now);
    return false;
  }
}
export function mayProposeDm(event: Event, signals: Signals): boolean {
  return event.direct && event.canManageTools === true && (signals.toolIntent ?? 0) >= 0.85 && signals.spam < 0.6;
}
export function replyDecision(event: Event, s: Signals, config: Config, cooldown: boolean): string {
  if(event.direct && !event.autonomous) return 'reply';
  if (s.spam >= 0.6) return 'spam';
  if (event.addressedToOther && !event.direct) return 'addressed-to-someone-else';
  if (cooldown) return 'cooldown';
  if (event.autonomous) return config.allowProactive && s.opportunity>=0.85 && s.interest>=0.55 ? 'reply' : 'autonomous-quiet';
  if (s.answered >= 0.9) return 'already-answered';
  if (event.direct || s.addressed >= 0.85) return 'reply';
  if (config.allowProactive && s.opportunity >= 0.9 && s.interest >= 0.65) return 'reply';
  return 'not-invited';
}
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private size = 0;
  constructor(readonly capacity = 10) {}
  get pending():number {return this.size;}
  add<T>(job: () => Promise<T>): Promise<T> {
    if (this.size >= this.capacity) return Promise.reject(new Error('Queue full; message skipped'));
    this.size++;
    const result = this.tail.then(job);
    this.tail = result.catch(() => undefined).finally(() => { this.size--; });
    return result;
  }
}
