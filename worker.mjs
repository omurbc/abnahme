import {execFileSync} from 'node:child_process';
import {existsSync,readFileSync,writeFileSync,renameSync,realpathSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {acquireWorkerLock} from './worker-lock.mjs';
import {createBuero,isSenden,sokosumiEvents} from './buero/sokosumi.mjs';
import {createPaidAdapter,isPaidReady} from './paid-task.mjs';
import {taskTarget,isTaskForTarget} from './task-target.mjs';
// The listing carries every Task description. Core answers at most ~4.5 MB, so the pipe must not be the smaller limit.
export function sokosumiCli(args){return JSON.parse(execFileSync('sokosumi',['--preprod',...args,'--json'],{encoding:'utf8',timeout:30000,maxBuffer:64*1024*1024}));}
// Write and rename: a crash leaves the old or the new journal, never a torn one.
export function writeJournal(taskId,state){const path=`.local/${taskId}.json`;writeFileSync(`${path}.tmp`,JSON.stringify(state),{mode:0o600});renameSync(`${path}.tmp`,path);}
export const abnahmeModule=impl=>impl==='local'?'./buero/abnahme-local.mjs':'./buero/abnahme.mjs';
export function createPaidSenden({buero,...deps}){
 return createPaidAdapter({...deps,answer:(input,_session,_deadline,task)=>buero.senden(input,task),recover:task=>buero.recover(task),save:async(taskId,state)=>writeJournal(taskId,state)});
}
// Polls until stop(); then finishes the pass and every in-flight PRÜFEN (its result is completed) before it returns.
export async function runWorker(worker,{wait=ms=>new Promise(r=>setTimeout(r,ms))}={}){
 for(;;){
  try{await worker.poll()}catch(e){console.error('Polling read failed',e.message.slice(0,200))}
  if(worker.stopping&&!worker.inflight.size)return;
  await Promise.race([wait(5000),...worker.inflight.values()]);
 }
}
const DONE=new Set(['completed','failed','closed']),PAID_DONE=new Set(['settled','failed']);
const CLOSABLE=new Set(['starting','started','result-saved','gate-failed','complete-pending','fail-pending']);
const TERMINAL=new Set(['COMPLETED','FAILED','CANCELED','CANCELLED']);
const MAX_PRUEFEN=2;  // each free PRÜFEN costs a Claude call or an escrow purchase
// An escrow run that ends FAILED with its journal still open (stage not 'done', the money not settled) is run once
// more after a pause, so an outage longer than the engine's error budget does not wait for the user to re-PRÜFEN.
// The engine resumes that journal and buys nothing; a closed journal is never rerun (that would buy again).
const RESUME_AFTER=5*60000;
const escrowJournalOpen=id=>{const path=`.local/abnahme-journal/${id}.json`;return existsSync(path)&&JSON.parse(readFileSync(path,'utf8')).stage!=='done';};
export function createWorker({target,cli,buero,paid,events,paidReady=isPaidReady}){
 const id=target.coworkerId,inflight=new Map(),lastWithdrawalPoll=new Map();let stopping=false;
 // A crash or a failed call can leave a phase whose next step never ran; the Core status in the listing decides.
 // Retrying start or complete is safe: the CLI re-reads the Task and refuses a second transition.
 function reconcile(t,state){
  let next=state;
  if(state.phase==='complete-pending'&&t.status==='COMPLETED'){next={...state,phase:'completed'};buero.confirm(t.id);}
  else if(state.phase==='fail-pending'&&t.status==='FAILED')next={...state,phase:'failed'};
  else if(TERMINAL.has(t.status)&&CLOSABLE.has(state.phase))next={...state,phase:'closed',coreStatus:t.status};
  else if(state.phase==='starting')next=t.status==='READY'?{}:t.status==='RUNNING'&&typeof t.description==='string'?{phase:'started',input:t.description}:state;
  // An abandoned PRÜFEN runs again with the same input; the escrow engine resumes its own journal for that input.
  else if(state.phase==='model-pending'&&!inflight.has(t.id))next={...state,phase:'started'};
  else if(state.phase==='complete-pending'&&t.status==='RUNNING')next={...state,phase:'result-saved'};
  else if(state.phase==='fail-pending'&&t.status==='RUNNING')next={...state,phase:'gate-failed'};
  if(next!==state){console.log('Recovered',t.id,state.phase,'->',next.phase??'new');if(next.phase)writeJournal(t.id,next);}
  return next;
 }
 async function step(t){
  const journal=`.local/${t.id}.json`,resultFile=`.local/${t.id}.txt`;
  let state=existsSync(journal)?JSON.parse(readFileSync(journal,'utf8')):{};
  if(state.paid?PAID_DONE.has(state.paid.stage):DONE.has(state.phase))return;  // finished Tasks cost nothing per poll
  if(state.paid&&process.env.PAID_TASKS_ENABLED!=='true')return;
  if(state.paid?.stage==='awaiting-withdrawal'){if(Date.now()-(lastWithdrawalPoll.get(t.id)??0)<60000)return;lastWithdrawalPoll.set(t.id,Date.now());}
  if(!state.paid)state=reconcile(t,state);
  if(t.status==='READY'&&!state.phase){
   if(stopping)return;
   writeJournal(t.id,{phase:'starting'});
   const started=cli(['runtime','start',t.id,...target.runtimeArgs,'--coworker-id',id]);
   state={phase:'started',input:started.description};writeJournal(t.id,state);
  }
  if(state.phase==='started'&&!state.paid&&isSenden(state.input)){
   if(stopping)return;
   const ready=process.env.PAID_TASKS_ENABLED==='true'&&paidReady();
   const check=ready?await buero.sendenGate(state.input,t):buero.sendenCheck(state.input,{taskId:t.id,userId:t.userId});
   const reason=!check.ok?check.reasonDe:!ready?'Bezahltes Senden ist noch nicht freigeschaltet.':null;
   if(reason){state={...state,phase:'gate-failed',error:`${reason} Es wurde nichts berechnet.`};writeJournal(t.id,state);}
  }
  if(state.paid||(state.phase==='started'&&isSenden(state.input))){
   state=await paid.advance(t,state);
   if(['gate-failed','fail-pending','failed'].includes(state.paid?.stage))buero.release(t.id);  // a failed SENDEN gives its invoice back
   return;
  }
  if(state.phase==='started'){
   if(stopping||state.resumeAt>Date.now())return;
   if(inflight.size>=MAX_PRUEFEN){
    if(!state.queued){writeJournal(t.id,{...state,queued:true});await events.comment(t.id,`Warteschlange: Es laufen bereits ${MAX_PRUEFEN} Prüfungen. Diese Prüfung startet automatisch, sobald eine fertig ist.`).catch(e=>console.error('Queue comment failed',t.id,e.message.slice(0,200)));}
    return;
   }
   // PRÜFEN can wait minutes on the escrow; run it beside the loop so paid Tasks keep their deadlines.
   writeJournal(t.id,{...state,phase:'model-pending'});
   const started=state;
   inflight.set(t.id,buero.pruefen({taskId:t.id,userId:t.userId??null,input:state.input,onProgress:text=>events.comment(t.id,text)})
    .then(result=>{writeFileSync(resultFile,result,{mode:0o600});return {...started,phase:'result-saved'};},e=>{
     if(!e.journalId||e.journalId===started.resumedJournal||!escrowJournalOpen(e.journalId))return {...started,phase:'gate-failed',error:e.message};
     console.log('Resuming',t.id,'escrow journal',e.journalId,'in',RESUME_AFTER/60000,'min');
     events.comment(t.id,`Die Prüfung wird in ${RESUME_AFTER/60000} Minuten einmal automatisch fortgesetzt: Escrow-Auftrag ${e.journalId} ist noch offen. Es wird nicht erneut gekauft.`).catch(c=>console.error('Resume comment failed',t.id,c.message.slice(0,200)));
     return {...started,resumedJournal:e.journalId,resumeAt:Date.now()+RESUME_AFTER};
    })
    .then(next=>writeJournal(t.id,next)).catch(e=>console.error('Journal write failed',t.id,e.message.slice(0,200))).finally(()=>inflight.delete(t.id)));
   return;
  }
  if(state.phase==='gate-failed'){
   writeJournal(t.id,{...state,phase:'fail-pending'});
   const failed=await events.fail(t.id,`Abgebrochen: ${state.error}`);
   writeJournal(t.id,{...state,phase:'failed',failedEventId:failed?.id});console.log('Failed',t.id);
   return;
  }
  if(state.phase==='result-saved'){
   writeJournal(t.id,{...state,phase:'complete-pending'});
   const completed=cli(['runtime','complete',t.id,...target.runtimeArgs,'--coworker-id',id,'--result-file',resultFile]);
   writeJournal(t.id,{...state,phase:'completed',completion:completed});buero.confirm(t.id);console.log('Completed',t.id);
  }
 }
 async function poll(){
  const tasks=cli(['tasks','list','--coworker-id',id,...target.taskArgs]).tasks;
  for(const t of tasks.filter(t=>isTaskForTarget(t,target))){
   try{await step(t)}catch(e){console.error('Task blocked',t.id,e.message.slice(0,200))}
  }
 }
 return {poll,inflight,stop(){stopping=true},get stopping(){return stopping}};
}
if(process.argv[1]&&realpathSync(process.argv[1])===fileURLToPath(import.meta.url)){
 const target=taskTarget();
 const releaseLock=acquireWorkerLock();
 process.once('exit',releaseLock);
 // First signal: start nothing new, finish the current pass and every in-flight PRÜFEN, then exit.
 // Second signal: exit now; the journals let the next start resume.
 let worker,wake=()=>{};
 for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{
  if(!worker||worker.stopping){releaseLock();process.exit(worker?1:0);}
  worker.stop();console.log('Stopping: waiting for',worker.inflight.size,'in-flight PRÜFEN. Signal again to exit now.');wake();
 });
 const {runAbnahme}=await import(abnahmeModule(process.env.ABNAHME_IMPL));
 const events=await sokosumiEvents(target),buero=createBuero({runAbnahme});
 const paid=await createPaidSenden({buero,target});
 worker=createWorker({target,cli:sokosumiCli,buero,paid,events});
 console.log('Continuous worker running',process.pid);
 await runWorker(worker,{wait:ms=>new Promise(r=>{wake=r;setTimeout(r,ms)})});
 console.log('Stopped',process.pid);releaseLock();process.exit(0);
}
