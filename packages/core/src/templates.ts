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
