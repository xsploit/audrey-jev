import type { Drives, Signals } from './types.js';
const baseline = { curiosity:0.4,socialBattery:0.8,tension:0.1 };
export function decayDrives(drives: Drives | undefined, now: number): Drives {
  if (!drives) return {...baseline,updatedAt:now};
  const retention = 2 ** (-Math.max(0,now-drives.updatedAt)/(20*60_000));
  return {curiosity:baseline.curiosity+(drives.curiosity-baseline.curiosity)*retention,
    socialBattery:baseline.socialBattery+(drives.socialBattery-baseline.socialBattery)*retention,
    tension:baseline.tension+(drives.tension-baseline.tension)*retention,updatedAt:now};
}
export function nudgeDrives(drives: Drives | undefined, signals: Signals, now: number): Drives {
  const current = decayDrives(drives,now);
  return {...current,curiosity:current.curiosity+0.08*(signals.interest-current.curiosity),
    tension:current.tension+0.08*((1-signals.valence)*signals.arousal-current.tension)};
}
export function spendSocialBattery(drives: Drives): Drives {
  return {...drives,socialBattery:Math.max(0,drives.socialBattery-0.025)};
}
