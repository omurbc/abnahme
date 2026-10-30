// Preload that refuses to start a process unless its environment came from one generated profile and holds no
// project secret outside that profile (audit SECRETS-1). Use it with the profile's file only:
//   node --env-file=.local/env/<profile>.env --import=./scripts/env-guard.mjs <entry>.mjs
import {checkEnv,checkDotEnv} from './env-split.mjs';

const profile=process.env.ABNAHME_ENV_PROFILE;
if(!profile){
 console.error('env-guard: no ABNAHME_ENV_PROFILE. Start with --env-file=.local/env/<profile>.env (written by node scripts/env-split.mjs).');
 process.exit(1);
}
const unneeded=checkEnv(process.env,profile);
if(unneeded.length){
 console.error(`env-guard: profile ${profile} must not hold ${unneeded.join(', ')}. Start it with --env-file=.local/env/${profile}.env only.`);
 process.exit(1);
}
// The Eve dev server (npm start) loads the repo-root .env files into its own env after this check (DELTA-SECRETS-2).
const reloaded=checkDotEnv(profile);
if(reloaded.length){
 console.error(`env-guard: profile ${profile} starts a process that loads the repo-root .env files itself, and they hold ${reloaded.join(', ')}. Move those secrets to .local/secrets.env (read by scripts/env-split.mjs) first.`);
 process.exit(1);
}
