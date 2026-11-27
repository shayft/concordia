import { workflowSpecSchema, type WorkflowSpec } from '@concordia/protocol/workflow';

export function demoSpec(): WorkflowSpec {
  const members = [
    ['lead', '团队负责人'],
    ['frontend', '前端'],
    ['backend', '后端'],
    ['qa', '测试'],
    ['docs', '交付支持'],
  ];
  return workflowSpecSchema.parse({
    id: 'assignee-filter',
    title: '按负责人筛选任务',
    goal: '让用户按负责人筛选任务板',
    acceptance: ['可筛选指定成员', '可查看未分配任务', '可清除筛选恢复全部'],
    requiredSlots: ['contract', 'backend-code', 'frontend-code', 'integration'],
    requiredTasks: ['accept'],
    agents: members.map(([id, name]) => ({
      id,
      name,
      connection: 'mock-' + id,
      role: id === 'lead' ? 'lead' : 'member',
    })),
    slots: [
      ['contract', '接口约定'],
      ['backend-code', '接口实现'],
      ['frontend-code', '筛选控件'],
      ['cases', '测试用例'],
      ['integration', '联调记录'],
      ['manual', '使用说明'],
    ].map(([id, title]) => ({ id, title })),
    tasks: [
      { id: 'api', title: '约定接口并实现筛选', owner: 'backend', produces: ['contract', 'backend-code'] },
      {
        id: 'ui',
        title: '实现筛选控件',
        owner: 'frontend',
        consumes: [{ slotId: 'contract' }],
        produces: ['frontend-code'],
      },
      {
        id: 'tests',
        title: '编写筛选用例',
        owner: 'qa',
        consumes: [{ slotId: 'contract' }],
        produces: ['cases'],
      },
      {
        id: 'integrate',
        title: '按版本联调',
        owner: 'qa',
        consumes: ['backend-code', 'frontend-code', 'cases'].map((slotId) => ({ slotId })),
        produces: ['integration'],
      },
      {
        id: 'guide',
        title: '补充使用说明',
        owner: 'docs',
        consumes: [{ slotId: 'frontend-code' }],
        produces: ['manual'],
      },
      { id: 'accept', title: '验收筛选行为', owner: 'lead', consumes: [{ slotId: 'integration' }] },
    ],
  });
}

export function meetingSpec(goal: string, members: string[]): WorkflowSpec {
  const tasks = members.map((owner, index) => ({
    id: 'turn-' + index,
    owner,
    title: '发言 · ' + owner,
    produces: ['statement-' + index],
    consumes: index ? [{ slotId: 'statement-' + (index - 1) }] : [],
  }));
  return workflowSpecSchema.parse({
    id: 'meeting',
    title: '会议',
    goal,
    acceptance: ['主持人总结和下一步'],
    agents: [...new Set(members)].map((id) => ({
      id,
      name: id,
      connection: id,
      role: id === members[0] ? 'lead' : 'member',
    })),
    slots: [
      ...tasks.map((task) => ({ id: task.produces[0], title: task.title })),
      { id: 'minutes', title: '会议纪要' },
    ],
    tasks: [
      ...tasks,
      {
        id: 'summary',
        title: '总结会议',
        owner: members[0],
        produces: ['minutes'],
        consumes: tasks.map((task) => ({ slotId: task.produces[0] })),
      },
    ],
    requiredSlots: ['minutes'],
  });
}

export function parallelSpec(goal: string, members: string[], lead = members[0]): WorkflowSpec {
  if (!members.length) throw new Error('并行模式需要至少一个执行成员');
  const agents = [...new Set([...members, lead])].map((id) => ({
    id,
    name: id,
    connection: id,
    role: id === lead ? 'lead' : 'member',
  }));
  const tasks = members.map((owner, i) => ({
    id: 'work-' + i,
    title: '独立完成 · ' + owner,
    owner,
    produces: ['option-' + i],
  }));
  const slots = tasks.map((task) => ({ id: task.produces[0], title: task.title }));
  return workflowSpecSchema.parse({
    id: 'parallel',
    title: '并行比较',
    goal,
    agents,
    slots: [...slots, { id: 'comparison', title: '比较结论' }],
    tasks: [
      ...tasks,
      {
        id: 'compare',
        title: '比较独立方案',
        owner: lead,
        consumes: slots.map((s) => ({ slotId: s.id })),
        produces: ['comparison'],
      },
    ],
    acceptance: ['成员分别提交独立方案', '负责人比较各方案并给出结论'],
    requiredSlots: ['comparison'],
  });
}

export function reviewSpec(goal: string, producer: string, reviewers: string[]): WorkflowSpec {
  if (!reviewers.length || reviewers.includes(producer)) throw new Error('审查模式需要独立的审查成员');
  const members = [...new Set([producer, ...reviewers])];
  const reviews = reviewers.map((owner, i) => ({
    id: 'review-' + i,
    title: '审查 · ' + owner,
    owner,
    consumes: [{ slotId: 'draft' }],
    produces: ['feedback-' + i],
  }));
  const slots = reviews.map((t) => ({ id: t.produces[0], title: t.title }));
  return workflowSpecSchema.parse({
    id: 'review',
    title: '成果审查',
    goal,
    agents: members.map((id) => ({
      id,
      name: id,
      connection: id,
      role: id === producer ? 'lead' : 'member',
    })),
    slots: [{ id: 'draft', title: '初稿' }, ...slots, { id: 'final', title: '审查后成果' }],
    tasks: [
      { id: 'produce', title: '产出初稿', owner: producer, produces: ['draft'] },
      ...reviews,
      {
        id: 'revise',
        title: '回应意见并提交定稿',
        owner: producer,
        produces: ['final'],
        consumes: ['draft', ...slots.map((s) => s.id)].map((slotId) => ({ slotId })),
      },
    ],
    acceptance: ['独立审查意见已记录', '产出者处理意见并提交定稿'],
    requiredSlots: ['final'],
  });
}
