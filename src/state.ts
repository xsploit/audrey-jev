import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { ChannelState, Memory, Mood, StoredState, UserMemory } from './types.js';

const unit = z.number().finite().min(0).max(1);
const memory = z.object({ id: z.string(), text: z.string().max(500), createdAt: z.number().finite() });
const schema = z.object({ version: z.literal(1), channels: z.record(z.string(), z.object({
  paused: z.boolean(),
  contextResetAt: z.number().finite().optional(),
  drives: z.object({curiosity:unit,socialBattery:unit,tension:unit,updatedAt:z.number().finite()}).optional(),
  mood: z.object({ valence: unit, arousal: unit, dominance: unit, updatedAt: z.number().finite() }),
  users: z.record(z.string(), z.object({ enabled: z.boolean(), approved: z.array(memory).max(30), pending: z.array(memory).max(10) })),
})) });
export const baseline = { valence: 0.5, arousal: 0.3, dominance: 0.5 };
const clamp = (n: number) => Math.max(0, Math.min(1, n));
export function decayMood(mood: Mood, now: number): Mood {
  const retention = 2 ** (-Math.max(0, now - mood.updatedAt) / (10 * 60_000));
  return { valence: baseline.valence + (mood.valence - baseline.valence) * retention,
    arousal: baseline.arousal + (mood.arousal - baseline.arousal) * retention,
    dominance: baseline.dominance + (mood.dominance - baseline.dominance) * retention, updatedAt: now };
}
export function nudgeMood(mood: Mood, target: Pick<Mood, 'valence' | 'arousal' | 'dominance'>, now: number): Mood {
  const current = decayMood(mood, now);
  return { valence: clamp(current.valence + 0.15 * (target.valence - current.valence)),
    arousal: clamp(current.arousal + 0.15 * (target.arousal - current.arousal)),
    dominance: clamp(current.dominance + 0.15 * (target.dominance - current.dominance)), updatedAt: now };
}
export class Store {
  data: StoredState;
  constructor(readonly file?: string) {
    try {
      this.data = file && existsSync(file) ? schema.parse(JSON.parse(readFileSync(file, 'utf8'))) : { version: 1, channels: {} };
    } catch {
      throw new Error('Saved state is unreadable or invalid. Back it up and repair it; refusing to overwrite memories.');
    }
  }
  channel(id: string, now = Date.now()): ChannelState {
    return this.data.channels[id] ??= { paused: false, mood: { ...baseline, updatedAt: now }, users: {} };
  }
  user(channel: string, user: string): UserMemory {
    return this.channel(channel).users[user] ??= { enabled: false, approved: [], pending: [] };
  }
  candidates(channel: string, user: string): Memory[] {
    const memory = this.channel(channel).users[user];
    return memory?.enabled ? memory.approved.slice(-5) : [];
  }
  save(): void {
    if (!this.file) return;
    schema.parse(this.data);
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.tmp`;
    writeFileSync(temp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    renameSync(temp, this.file);
  }
}
