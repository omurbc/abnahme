import {execFileSync} from 'node:child_process';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {acquireWorkerLock} from './worker-lock.mjs';
import {createBuero,isSenden,sokosumiEvents} from './buero/sokosumi.mjs';
import {reply} from './comments.mjs';
import {createPaidAdapter,isPaidReady} from './paid-task.mjs';
import {taskTarget,isTaskForTarget} from './task-target.mjs';
const target=taskTarget();
const id=target.coworkerId;
const releaseLock=acquireWorkerLock();
process.once('exit',releaseLock);
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{releaseLock();process.exit(0)});
function cli(args){return JSON.parse(execFileSync('sokosumi',['--preprod',...args,'--json'],{encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024}));}
const {runAbnahme}=await import(process.env.ABNAHME_IMPL==='local'?'./buero/abnahme-local.mjs':'./buero/abnahme.mjs');
const events=await sokosumiEvents(target),buero=createBuero({runAbnahme}),inflight=new Map();
const paid=await createPaidAdapter({target,answer:input=>buero.senden(input),save:async(taskId,state)=>writeFileSync(`.local/${taskId}.json`,JSON.stringify(state),{mode:0o600})});
console.log('Continuous worker running',process.pid);
while(true){
 try{
 const tasks=cli(['tasks','list','--coworker-id',id,...target.taskArgs]).tasks;
 for(const t of tasks.filter(t=>isTaskForTarget(t,target))){
 try{
 const journal=`.local/${t.id}.json`,resultFile=`.local/${t.id}.txt`;
 let state=existsSync(journal)?JSON.parse(readFileSync(journal,'utf8')):{};
 if(t.status==='READY'&&!state.phase){writeFileSync(journal,JSON.stringify({phase:'starting'}),{mode:0o600});const started=cli(['runtime','start',t.id,...target.runtimeArgs,'--coworker-id',id]);state={phase:'started',input:started.description};writeFileSync(journal,JSON.stringify(state),{mode:0o600});}
 if(state.paid&&process.env.PAID_TASKS_ENABLED!=='true')continue;
 if(state.phase==='started'&&!state.paid&&isSenden(state.input)){
 const check=buero.sendenCheck(state.input);
 const reason=!check.ok?check.reasonDe:(process.env.PAID_TASKS_ENABLED!=='true'||!isPaidReady())?'Bezahltes Senden ist noch nicht freigeschaltet.':null;
 if(reason){state={...state,phase:'gate-failed',error:`${reason} Es wurde nichts berechnet.`};writeFileSync(journal,JSON.stringify(state),{mode:0o600});}
 }
 if(state.paid||(state.phase==='started'&&isSenden(state.input))){state=await paid.advance(t,state);if(state.phase==='completed')await reply(t);continue;}
 if(state.phase==='started'){
 // PRÜFEN can wait minutes on the escrow; run it beside the loop so paid Tasks keep their deadlines.
 writeFileSync(journal,JSON.stringify({...state,phase:'model-pending'}),{mode:0o600});
 const started=state;
 inflight.set(t.id,buero.pruefen({taskId:t.id,input:state.input,onProgress:text=>events.comment(t.id,text)})
  .then(result=>{writeFileSync(resultFile,result,{mode:0o600});return {...started,phase:'result-saved'};},e=>({...started,phase:'gate-failed',error:e.message}))
  .then(next=>{writeFileSync(journal,JSON.stringify(next),{mode:0o600});inflight.delete(t.id);}));
 continue;
 }
 if(state.phase==='gate-failed'){
 writeFileSync(journal,JSON.stringify({...state,phase:'fail-pending'}),{mode:0o600});
 const failed=await events.fail(t.id,`Abgebrochen: ${state.error}`);
 writeFileSync(journal,JSON.stringify({...state,phase:'failed',failedEventId:failed?.id}),{mode:0o600});console.log('Failed',t.id);
 }
 if(state.phase==='result-saved'){
 writeFileSync(journal,JSON.stringify({...state,phase:'complete-pending'}),{mode:0o600});
 const completed=cli(['runtime','complete',t.id,...target.runtimeArgs,'--coworker-id',id,'--result-file',resultFile]);
 writeFileSync(journal,JSON.stringify({...state,phase:'completed',completion:completed}),{mode:0o600});console.log('Completed',t.id);
 }
 if(state.phase==='completed')await reply(t);
 }catch(e){console.error('Task blocked',t.id,e.message.slice(0,200))}
 }
 }catch(e){console.error('Polling read failed',e.message.slice(0,200))}
 await new Promise(r=>setTimeout(r,5000));
}
