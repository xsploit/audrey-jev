import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import type { Config } from './types.js';
import { readSpeechSettings } from './escape-speech.js';
import { FISH_REFERENCE } from './fish-speech.js';

export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const bool = (name: string, fallback: boolean) => {
    const value = env[name];
    if (value === undefined || value === '') return fallback;
    if (value !== 'true' && value !== 'false') throw new Error(`${name} must be true or false`);
    return value === 'true';
  };
  const integer = (name: string, fallback: number, max: number) => {
    const value = Number(env[name] || fallback);
    if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`${name} must be an integer from 1 to ${max}`);
    return value;
  };
  const allowedChannels = new Set((env.DISCORD_CHANNEL_IDS ?? '').split(',').map(s=>s.trim()).filter(Boolean));
  const passiveGuilds = new Set((env.PASSIVE_GUILD_IDS ?? '').split(',').map(s=>s.trim()).filter(Boolean));
  const defaultMemoryUserIds = (env.MEMORY_DEFAULT_USER_IDS ?? '').split(',').map(s=>s.trim()).filter(Boolean);
  const guildId = env.DISCORD_GUILD_ID ?? '';
  const escapeSpeechProvider=env.ESCAPE_TTS_PROVIDER || 'edge';
  if(!['edge','fish'].includes(escapeSpeechProvider))throw new Error('ESCAPE_TTS_PROVIDER must be edge or fish');
  const fishReference=env.FISH_REFERENCE_ID || FISH_REFERENCE;
  if(!/^[a-f0-9]{32}$/i.test(fishReference))throw new Error('FISH_REFERENCE_ID must be a 32-character reference ID');
  if (![...allowedChannels, ...passiveGuilds, ...defaultMemoryUserIds, ...(guildId ? [guildId] : [])].every(s=>/^\d{17,20}$/.test(s))) throw new Error('Guild/channel IDs must be Discord snowflakes');
  const config: Config = { botName: env.BOT_NAME || 'Audrey', interests: env.BOT_INTERESTS || 'coding, AI, Linux, synthesizers, music production',
    dryRun: bool('DRY_RUN',false), allowProactive: bool('ALLOW_PROACTIVE',true),
    moodEnabled: bool('ENABLE_MOOD',true), memoryEnabled: bool('ENABLE_MEMORY',true), defaultMemoryUserIds,
    cooldownMs: integer('CHANNEL_COOLDOWN_SECONDS',30,3600)*1000,
    maxEvaluationsPerHour: integer('MAX_EVALUATIONS_PER_HOUR',120,1000), maxCallsPerMinute: integer('MAX_CALLS_PER_MINUTE',10,60) };
  return { config, allowedChannels, passiveGuilds, guildId, token: env.DISCORD_TOKEN ?? '', apiKey: env.AI_GATEWAY_API_KEY ?? '',
    writerModel: env.WRITER_MODEL ?? '', dataFile: resolve(env.DATA_FILE || './data/state.json'), escapeComponentsV2: bool('ESCAPE_COMPONENTS_V2',true),
    escapeSpeech:bool('ESCAPE_TTS_ENABLED',true) ? readSpeechSettings(env) : undefined,
    escapeSpeechProvider,fishReference,fishApiKey:env.FISH_API_KEY || '' };
}
export function loadConfig() { loadEnv({ quiet: true }); loadEnv({path:resolve('data/voice-lab.env'),quiet:true}); return readConfig(); }
