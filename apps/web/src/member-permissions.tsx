import { useState } from 'react';
import { actionTools, type ActionName } from '@concordia/protocol';
import type { Member } from '@concordia/protocol/connections';
import { Field } from './ui.tsx';

const labels: Record<ActionName, string> = {
  create_task: '创建任务',
  assign_task: '指派任务',
  publish_artifact: '发布交付物',
  read_artifact: '阅读交付物',
  ask_question: '提问',
  answer_question: '回答问题',
  send_message: '发送消息',
  progress: '更新进度',
  submit_result: '提交结果',
  request_review: '申请审查',
  run_project_command: '申请运行项目命令',
  read_file: '读取工作树文件',
  write_file: '写入工作树文件',
  commit_artifact: '提交工作树交付版本',
};
export function MemberPermissions({ member, members }: { member?: Member; members: Member[] }) {
  const [custom, setCustom] = useState(member?.allowedActions !== undefined);
  return (
    <div className="stack member-permissions">
      <Field name="reportsTo" label="直属上级">
        <select id="reportsTo" name="reportsTo" defaultValue={member?.reportsTo ?? ''}>
          <option value="">未设置</option>
          {members
            .filter((m) => m.id !== member?.id)
            .map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
        </select>
      </Field>
      <div>
        <label className="check">
          <input
            type="checkbox"
            name="customActions"
            checked={custom}
            onChange={(e) => setCustom(e.target.checked)}
          />
          逐项限制岗位动作
        </label>
        {custom ? (
          <>
            <p className="help">空清单将禁止该岗位的全部模型动作。勾选的动作仍受任务与工作树授权约束。</p>
            <div className="form-grid action-list">
              {actionTools.map((tool) => (
                <label className="check" key={tool.name}>
                  <input
                    type="checkbox"
                    name="allowedActions"
                    value={tool.name}
                    defaultChecked={member?.allowedActions?.includes(tool.name) ?? false}
                  />
                  {labels[tool.name]}
                </label>
              ))}
            </div>
          </>
        ) : (
          <p className="help">使用运行时的默认权限。</p>
        )}
      </div>
    </div>
  );
}
