import { platformActionSchema } from '@concordia/protocol';
import { workflowSpecSchema, type WorkflowSpec } from '@concordia/protocol/workflow';
import type { CoreDependencies } from './index.ts';
import {
  activePlan, column, entity, fence, inputsFor, latest, makeTask, refresh, reopen, transition,
  type Append, type Control, type Execution, type Failure, type State, type WorkflowStorage,
} from './state.ts';
import { applyAction } from './workflow-actions.ts';
export * from './state.ts';
export * from './templates.ts';

function planDiff(state:State,spec:WorkflowSpec) {
  const prior=state.spec?.tasks??[];
  const before=new Map(prior.map(task=>[task.id,task]));
  const after=new Set(spec.tasks.map(task=>task.id));
  return {
    spec,revision:state.revision,
    added:spec.tasks.filter(task=>!before.has(task.id)).map(task=>task.id),
    removed:prior.filter(task=>!after.has(task.id)).map(task=>task.id),
    changed:spec.tasks.filter(task=>before.has(task.id)&&JSON.stringify(task)!==JSON.stringify(before.get(task.id))).map(task=>task.id),
  };
}

export class Scheduler {
  constructor(private readonly deps: CoreDependencies<WorkflowStorage>) {}
  private write<T>(callback:(state:State,append:Append)=>T):T {
    return this.deps.storage.transaction((state,append)=>callback(state,(type,data)=>append(type,{...data,time:this.deps.now()})));
  }
  preview(input:unknown) {
    return planDiff(this.deps.storage.read(),workflowSpecSchema.parse(input));
  }
  apply(input:unknown,expectedRevision?:number) {
    const spec=workflowSpecSchema.parse(input);
    return this.write((s,log)=>{
      if(expectedRevision!==undefined && s.revision!==expectedRevision) throw new Error('计划版本已改变，请重新预览');
      if(JSON.stringify(spec)===JSON.stringify(s.spec)) return {revision:s.revision};
      const diff=planDiff(s,spec);
      if(s.executions.length && s.spec?.id!==spec.id) throw new Error('新工作流需要独立工作区');
      if(s.tasks.some(t=>t.active)) throw new Error('请先暂停运行中的任务');
      const revised=new Set([...diff.removed,...diff.changed]);
      if(s.executions.some(e=>revised.has(e.taskId))) throw new Error('已有执行的任务须通过改派或返工更新');
      if(s.questions.some(q=>q.status==='open' && q.to!=='user' && !spec.agents.some(a=>a.id===q.to))) throw new Error('仍有问题等待该成员答复');
      if(spec.tasks.some(t=>t.consumes.some(c=>c.policy==='pinned'&&!s.versions.some(v=>v.id===c.version&&v.slotId===c.slotId)))) throw new Error('钉住的交付物版本不存在');
      s.spec=spec;
      s.tasks=[...spec.tasks.map(t=>!revised.has(t.id) && s.tasks.find(old=>old.id===t.id) || makeTask(t)),...s.tasks.filter(t=>t.replyFor)];
      for(const task of s.tasks) if(task.status==='ready'||task.status==='waiting') refresh(task,s);
      s.revision++;
      s.plans.push(this.deps.storage.putContent(JSON.stringify(spec)));
      s.acceptance=null;
      log('plan.applied',{revision:s.revision,added:diff.added,removed:diff.removed,changed:diff.changed});
      return {revision:s.revision};
    });
  }
  board() {
    const s=this.deps.storage.read();
    const tasks=s.tasks.map(t=>{
      const inputs=inputsFor(t,s);
      return {...t,column:column(t),missing:t.consumes.filter(c=>!inputs[c.slotId]).map(c=>c.slotId)};
    });
    const slots=(s.spec?.slots??[]).map(slot=>({...slot,producer:tasks.find(t=>t.produces.includes(slot.id))?.id,
      waiting:tasks.filter(t=>t.missing.includes(slot.id)).map(t=>t.id)}));
    return {...s,tasks,slots,agents:s.spec?.agents??[]};
  }
  events(after=0) {return this.deps.storage.events(after);}
  context(executionId:string) {
    return JSON.parse(this.deps.storage.getContent(entity(this.deps.storage.read().executions,executionId).contextRef)) as {
      goal:string;acceptance:string[];task:string;inputs:Record<string,string>;questions:State['questions'];messages:State['messages'];
    };
  }
  readVersion(versionId:string) {
    const version=entity(this.deps.storage.read().versions,versionId);
    return {...version,content:this.deps.storage.getContent(version.contentRef)};
  }
  isRunning(filter:{memberId?:string;connectionId?:string;poolId?:string}={}) {
    return this.deps.storage.read().executions.some(e=>e.status==='running' &&
      (!filter.memberId||e.owner===filter.memberId)&&(!filter.connectionId||e.connection===filter.connectionId)&&(!filter.poolId||e.pool===filter.poolId));
  }
  claim(taskId:string):Execution {
    const result=this.write((s,log)=>{
      const task=entity(s.tasks,taskId), plan=activePlan(s), agent=entity(plan.agents,task.owner);
      if(task.status!=='ready') throw new Error('任务尚未就绪');
      const pool=agent.pool??agent.connection;
      const running=s.executions.filter(e=>e.status==='running'&&e.pool===pool).length;
      if(s.stoppedPools.includes(pool)||running>=(plan.poolLimits[pool]??1)) throw new Error('额度池暂停或并发已满');
      const calls=(items:Execution[])=>items.reduce((sum,e)=>sum+e.calls,0);
      if(calls(s.executions)>=plan.maxCalls || calls(s.executions.filter(e=>e.taskId===task.id))>=task.maxCalls) {
        transition(task,'decision','调用预算已用尽'); log('budget.exhausted',{taskId});return null;
      }
      const id=this.deps.nextId(),inputs=inputsFor(task,s);
      const context={goal:plan.goal,acceptance:plan.acceptance,task:task.title,
        inputs:Object.fromEntries(Object.entries(inputs).map(([slot,ver])=>[slot,this.deps.storage.getContent(entity(s.versions,ver).contentRef)])),
        questions:s.questions.filter(q=>q.to===agent.id && q.status==='open'),
        messages:s.messages.filter(m=>m.to===agent.id)};
      const encoded=JSON.stringify(context);
      if(encoded.length>128_000) throw new Error('输入超过上下文限制');
      const execution:Execution={id,taskId,owner:agent.id,connection:agent.connection,pool,inputs,outputs:{},
        contextRef:this.deps.storage.putContent(encoded),started:this.deps.now(),calls:1,status:'running'};
      task.active=id;transition(task,'running');s.executions.push(execution);log('execution.started',{id,taskId,inputs,connection:agent.connection});
      return execution;
    });
    if(!result) throw new Error('调用预算已用尽');
    return result;
  }
  act(executionId:string,input:unknown,deliveryId?:string):unknown {
    const action=platformActionSchema.parse(input);
    return this.write((s,log)=>{
      const exec=entity(s.executions,executionId),task=entity(s.tasks,exec.taskId);
      const key=deliveryId?JSON.stringify([executionId,deliveryId]):undefined;
      const fingerprint=key?this.deps.storage.putContent(JSON.stringify(action)):'';
      if(key && Object.hasOwn(s.receipts,key)){
        if(s.receipts[key].fingerprint!==fingerprint) throw new Error('重复消息编号的内容不同');
        return s.receipts[key].result;
      }
      if(task.active!==exec.id || exec.status!=='running') {
        log('execution.late',{id:executionId,action:action.type,contentRef:this.deps.storage.putContent(JSON.stringify(action))});return {obsolete:true};
      }
      const result=applyAction(s,exec,task,action,log,this.deps);
      if(key) s.receipts[key]={fingerprint,result};
      return result;
    });
  }
  reserveCall(executionId:string) {
    const ok=this.write((s,log)=>{
      const exec=entity(s.executions,executionId),task=entity(s.tasks,exec.taskId),plan=activePlan(s);
      if(exec.status!=='running'||task.active!==exec.id) throw new Error('执行已结束');
      const total=s.executions.reduce((sum,e)=>sum+e.calls,0);
      const taskCalls=s.executions.reduce((sum,e)=>sum+(e.taskId===task.id?e.calls:0),0);
      if(total>=plan.maxCalls || taskCalls>=task.maxCalls) {
        fence(s,task,'failed',this.deps.now());transition(task,'decision','调用预算已用尽');
        log('budget.exhausted',{taskId:task.id,id:exec.id});return false;
      }
      exec.calls++;log('call.reserved',{id:exec.id,calls:exec.calls});return true;
    });
    if(!ok) throw new Error('调用预算已用尽');
  }
  recordUsage(executionId:string,usage:{inputTokens?:number;outputTokens?:number}) {
    this.write((s,log)=>{
      const e=entity(s.executions,executionId);
      for(const count of Object.values(usage)) if(count!==undefined&&(!Number.isSafeInteger(count)||count<0)) throw new Error('用量无效');
      if(usage.inputTokens===undefined&&usage.outputTokens===undefined) return;
      e.usage??={};
      if(usage.inputTokens!==undefined) e.usage.input=(e.usage.input??0)+usage.inputTokens;
      if(usage.outputTokens!==undefined) e.usage.output=(e.usage.output??0)+usage.outputTokens;
      log('usage.recorded',{id:executionId,...usage});
    });
  }
  fail(executionId:string,kind:Failure) {
    return this.write((s,log)=>{
      const exec=entity(s.executions,executionId),task=entity(s.tasks,exec.taskId);
      if(task.active!==exec.id){log('execution.late',{id:executionId,kind});return;}
      fence(s,task,'failed',this.deps.now());
      if(kind==='rate_limit' && !s.stoppedPools.includes(exec.pool)) s.stoppedPools.push(exec.pool);
      if(kind==='transient' && task.retries<task.maxRetries){task.retries++;refresh(task,s);}
      else transition(task,kind==='fatal'||kind==='transient'?'failed':'decision',kind);
      log('execution.failed',{id:exec.id,kind,status:task.status});
    });
  }
  resumePool(pool:string) {
    this.write((s,log)=>{s.stoppedPools=s.stoppedPools.filter(p=>p!==pool);log('pool.resumed',{pool});});
  }
  control(taskId:string,operation:Control) {
    return this.write((s,log)=>{
      const task=entity(s.tasks,taskId);
      switch(operation) {
        case 'cancel': case 'pause':
          if(['done','failed','cancelled'].includes(task.status)) throw new Error('任务已经结束');
          fence(s,task,'cancelled',this.deps.now());transition(task,operation==='pause'?'paused':'cancelled');break;
        case 'resume': case 'retry':
          if(!['paused','decision','failed'].includes(task.status)) throw new Error('当前状态无法恢复');
          refresh(task,s);break;
        case 'accept': case 'rework':
          if(task.status!=='review') throw new Error('任务尚未进入审查');
          if(operation==='accept') transition(task,'done');else reopen(task,s,this.deps.now());
          break;
        default: throw new Error('未知控制指令');
      }
      log('task.control',{taskId,operation,status:task.status});return task;
    });
  }
  reassign(taskId:string,owner:string) {
    return this.write((s,log)=>{
      const task=entity(s.tasks,taskId),plan=activePlan(s);
      entity(plan.agents,owner);
      if(task.replyFor || ['done','cancelled'].includes(task.status)) throw new Error('此任务不能改派');
      fence(s,task,'obsolete',this.deps.now());task.owner=owner;entity(plan.tasks,taskId).owner=owner;
      s.revision++;s.plans.push(this.deps.storage.putContent(JSON.stringify(plan)));refresh(task,s);s.acceptance=null;
      log('task.reassigned',{taskId,owner,revision:s.revision});return task;
    });
  }
  stopAll() {
    return this.write((s,log)=>{
      for(const task of s.tasks) if(!['done','cancelled','failed'].includes(task.status)) {
        fence(s,task,'cancelled',this.deps.now());transition(task,'cancelled');log('task.cancelled',{taskId:task.id});
      }
    });
  }
  recover() {
    return this.write((s,log)=>{
      let count=0;
      for(const task of s.tasks) if(task.active) {
        const id=task.active;fence(s,task,'interrupted',this.deps.now());transition(task,'decision','上次执行中断');
        log('execution.interrupted',{id,taskId:task.id});count++;
      }
      return count;
    });
  }
  accept() {
    return this.write((s,log)=>{
      const plan=activePlan(s),snapshot:Record<string,string>={};
      for(const slot of plan.requiredSlots){
        const v=latest(s,slot);
        if(!v || v.stale || entity(s.tasks,v.taskId).status!=='done') throw new Error('必需交付物未验收或已过期');
        snapshot[slot]=v.id;
      }
      if(s.questions.some(q=>q.status==='open' && q.blocking)) throw new Error('尚有未答复的阻塞问题');
      s.acceptance=snapshot;log('plan.accepted',{snapshot,revision:s.revision});return snapshot;
    });
  }
}
