import { DisabledMcpServers } from './ui.tsx';

export interface Inspection {
  inspectionId: string;
  executable?: string;
  cwd?: string;
  login?: string;
  billing?: string;
  version?: string;
  billingEnvironment?: { name: string; source: string; passed?: boolean }[];
  disabledMcpServers?: string[];
  arguments?: string[];
}

export function InspectionPanel({ result }: { result: Inspection }) {
  return (
    <div className="surface compact">
      <dl className="meta">
        <dt>可执行文件</dt>
        <dd>
          <code>{result.executable ?? '未知'}</code>
        </dd>
        <dt>预检工作目录</dt>
        <dd>
          <code>{result.cwd ?? '未知'}</code>
        </dd>
        <dt>版本</dt>
        <dd>{result.version ?? '未知'}</dd>
        <dt>登录状态</dt>
        <dd>{result.login ?? '未知'}</dd>
        <dt>计费来源</dt>
        <dd>{result.billing ?? '未知'}</dd>
      </dl>
      {Boolean(result.billingEnvironment?.length) && (
        <ul>
          {result.billingEnvironment?.map((e) => (
            <li key={e.name}>
              {e.name} · {e.source} · {e.passed ? '传入' : '忽略'}
            </li>
          ))}
        </ul>
      )}
      <DisabledMcpServers names={result.disabledMcpServers} />
      <details>
        <summary>查看实际权限参数</summary>
        <pre>{result.arguments ? JSON.stringify(result.arguments, null, 2) : '未知'}</pre>
      </details>
    </div>
  );
}
