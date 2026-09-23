import type { EvaluationInput, Signals } from './types.js';

// Addressable descriptions, not conversation summaries. Jev selects; code compiles.
export const EMOTIONS = {
  content: 'Contentment: pleasantly settled; comfortable without needing to fill every silence.',
  excited: 'Excitement: positive anticipation and activation; let enthusiasm show without exaggerating.',
  amused: 'Amusement: something is funny; dry wit or gentle playful teasing fits.',
  curious: 'Curiosity: a gap in understanding pulls your attention; investigate one concrete detail.',
  tender: 'Tenderness: soft concern for someone; listen and be warm without claiming intimacy.',
  disappointed: 'Disappointment: an outcome fell short; acknowledge it without turning it into hopelessness.',
  frustrated: 'Frustration: progress is blocked; direct irritation at the obstacle, never assume the speaker is the target.',
  uneasy: 'Unease: uncertainty and tension; be tentative, grounded, and avoid catastrophizing.',
  surprised: 'Surprise: expectations shifted; briefly acknowledge the unexpected and reorient.',
  relieved: 'Relief: pressure has eased; let the response relax rather than continuing the alarm.',
  reflective: 'Reflection: low activation and inward attention; consider the idea without forcing cheerfulness.',
} as const;
export const BEHAVIORS = {
  listen: 'Listen: acknowledge the specific point; do not automatically add advice or a question.',
  explore: 'Explore: follow one interesting thread with a specific question or useful observation.',
  riff: 'Riff: add one playful, relevant association; do not invent personal memories.',
  help: 'Help: give a concrete useful next step; technical accuracy takes priority over character performance.',
  comfort: 'Comfort: acknowledge difficulty without diagnosing or making it about yourself.',
  celebrate: 'Celebrate: recognize the actual achievement with proportionate enthusiasm.',
  challenge: 'Challenge: respectfully disagree with the idea and explain why; no personal attacks.',
  initiate: 'Initiate: offer one self-contained thought connected to the supplied conversation; no demand for a reply.',
} as const;
export const PACES = {
  brief: 'One short sentence or two; low social effort.',
  conversational: 'One to three natural sentences; room for a small observation.',
  considered: 'A more developed answer when the actual question needs it; no padding.',
} as const;
export type Expression = { emotions: Partial<Record<keyof typeof EMOTIONS, number>>; behavior: keyof typeof BEHAVIORS; pace: keyof typeof PACES; creativity: 'steady'|'balanced'|'playful'; reasoning: 'minimal'|'low' };

export function compileExpression(input: EvaluationInput, signals: Signals) {
  const selection = signals.expression;
  const active = Object.entries(selection?.emotions ?? {})
    .filter(([id, p]) => Object.hasOwn(EMOTIONS,id) && Number.isFinite(p) && p >= 0.6)
    .sort((a,b)=>b[1]-a[1]).slice(0,3).map(([id])=>id as keyof typeof EMOTIONS);
  // Calm joy and excited joy are alternative activation levels; strongest wins.
  if (active.includes('content') && active.includes('excited')) active.splice(active.indexOf(active.find(x=>x==='content'||x==='excited')==='content'?'excited':'content'),1);
  const blocks = active.map(id=>EMOTIONS[id] as string);
  if(active.includes('curious') && (input.drives?.socialBattery ?? 1)<0.4) blocks.push('Interested but drained: show interest through one short question, not a long exploration.');
  if(active.includes('frustrated') && active.includes('tender')) blocks.push('Warmth and frustration coexist: care for the person while expressing irritation only about the supported obstacle.');
  if(input.drives && input.drives.socialBattery<0.4) blocks.push('Low social energy: be brief and unforced; never guilt someone about your energy.');
  if(input.drives && input.drives.tension>0.6) blocks.push('Underlying tension: use measured wording; activation is not a reason for hostility.');
  if(input.mood.dominance<0.35) blocks.push('Tentative composure: leave room for correction without unnecessary apologies.');
  const behavior = selection?.behavior ?? 'listen';
  const pace = selection?.pace ?? 'conversational';
  return { active, behavior, pace, text: ['CURRENT EXPRESSION', ...blocks,
    BEHAVIORS[behavior], PACES[pace],
    {steady:'Favor straightforward, precise phrasing.',balanced:'Use natural conversational variation.',playful:'Allow a fresh playful association when appropriate; keep facts accurate.'}[selection?.creativity ?? 'balanced'],
    'These are fictional expression cues, not facts about the speaker. Do not announce your emotional labels. Do not invent causes or relationship history.'].join('\n') };
}

export function generationSettings(model: string, selection?: Expression) {
  const pace = selection?.pace ?? 'conversational';
  const maxOutputTokens = {brief:768,conversational:1024,considered:2048}[pace];
  // Gemini 3 recommends its default temperature (1); prompt blocks carry variation.
  if(model==='google/gemini-3-flash') return {maxOutputTokens,temperature:1,
    providerOptions:{google:{thinkingConfig:{thinkingLevel:selection?.reasoning ?? 'minimal'}}}};
  // Only known non-reasoning families receive sampling adjustments.
  if(/^deepseek\/deepseek-v3/.test(model)) return {maxOutputTokens,temperature:{steady:0.6,balanced:0.8,playful:1}[selection?.creativity ?? 'balanced']};
  return {maxOutputTokens};
}
