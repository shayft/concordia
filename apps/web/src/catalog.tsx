import { useRef, useEffect, useState, type FormEvent } from 'react';
import type { Catalog, CatalogModel, Connection, Member, QuotaPool } from '@concordia/protocol/connections';
import { modelPricingSchema } from '@concordia/protocol/pricing';
import { MemberPermissions } from './member-permissions.tsx';
import { api, useAction, useResource } from './api.ts';
import { Empty, Field, Modal, Notice } from './ui.tsx';

const protocols = {
  claude: 'Claude Code',
  codex: 'Codex CLI',
  'chat-completions': 'Chat Completions',
  responses: 'OpenAI Responses',
  gemini: 'Gemini Native',
  anthropic: 'Anthropic Messages',
};
type Tab = 'connections' | 'models' | 'members' | 'pools';
type Row = Connection | CatalogModel | Member | QuotaPool;
function isConnection(row: Row): row is Connection {
  return 'kind' in row;
}
function isMember(row: Row): row is Member {
  return 'role' in row;
}
const tabs = { connections: '连接', models: '模型', members: '岗位', pools: '额度池' };
const cli = (kind: Connection['kind']) => kind === 'claude' || kind === 'codex';
const text = (form: FormData, field: string) => String(form.get(field) ?? '').trim();
function readPricing(form: FormData) {
  const currency = text(form, 'currency');
  const input = text(form, 'inputPerMillion');
  const output = text(form, 'outputPerMillion');
  if (!input && !output && !currency) return undefined;
  const parsed = modelPricingSchema.safeParse({
    currency,
    inputPerMillion: input ? Number(input) : undefined,
    outputPerMillion: output ? Number(output) : undefined,
  });
  if (!parsed.success) throw new Error('定价需要三位币种代码和至少一项非负单价。');
  return parsed.data;
}

type FormProps = {
  tab: Tab;
  catalog: Catalog;
  id?: string;
  onClose: () => void;
  refresh: () => Promise<void>;
};

function Editor({ tab, catalog, id, onClose, refresh }: FormProps) {
  const connection = catalog.connections.find((c) => c.id === id);
  const cliConnection = connection && !('baseUrl' in connection) ? connection : undefined;
  const apiConnection = connection && 'baseUrl' in connection ? connection : undefined;
  const model = catalog.models.find((m) => m.id === id);
  const member = catalog.members.find((m) => m.id === id);
  const pool = catalog.pools.find((p) => p.id === id);
  const item = { connections: connection, models: model, members: member, pools: pool }[tab];
  const [kind, setKind] = useState<Connection['kind']>(connection?.kind ?? 'chat-completions');
  const [connectionId, setConnectionId] = useState(
    (tab === 'members' ? member : model)?.connectionId ?? catalog.connections[0]?.id ?? '',
  );
  const feedback = useAction();
  const selectable = catalog.models.filter((m) => m.connectionId === connectionId);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const recordId = id ?? text(fields, 'id');
    const base = { id: recordId, name: text(fields, 'name') };
    const enabled = !item || !('enabled' in item) || item.enabled;
    const ref = text(fields, 'credentialRef');
    void feedback.run(async () => {
      const json = (field: string) => {
        const value = text(fields, field);
        if (!value) return undefined;
        try {
          return JSON.parse(value) as unknown;
        } catch {
          throw new Error('请输入合法的 JSON 对象。');
        }
      };
      const data =
        tab === 'connections'
          ? {
              ...base,
              enabled,
              kind,
              poolId: text(fields, 'poolId') || undefined,
              maxConcurrent: Number(text(fields, 'maxConcurrent') || 1),
              ...(cli(kind)
                ? {
                    executable: text(fields, 'executable') || undefined,
                    cwd: text(fields, 'cwd') || undefined,
                    actionChannel: text(fields, 'actionChannel') || undefined,
                  }
                : {
                    baseUrl: text(fields, 'baseUrl'),
                    credentialRef: ref || undefined,
                    endpoint: text(fields, 'endpoint') || undefined,
                    headerRefs: json('headerRefs'),
                    params: json('params'),
                    timeoutMs: Number(text(fields, 'timeoutMs')) || undefined,
                    maxOutputTokens: Number(text(fields, 'maxOutputTokens')) || undefined,
                  }),
            }
          : tab === 'models'
            ? {
                ...base,
                enabled,
                connectionId,
                modelId: text(fields, 'modelId'),
                pricing: readPricing(fields),
                params: json('params'),
                toolMode: text(fields, 'toolMode') || undefined,
              }
            : tab === 'members'
              ? {
                  ...base,
                  enabled,
                  connectionId,
                  role: text(fields, 'role'),
                  reportsTo: text(fields, 'reportsTo') || undefined,
                  allowedActions: fields.has('customActions')
                    ? fields.getAll('allowedActions').map(String)
                    : undefined,
                  systemPrompt: text(fields, 'systemPrompt') || undefined,
                  modelId: text(fields, 'modelId') || undefined,
                }
              : { ...base, maxConcurrent: Number(text(fields, 'maxConcurrent')) };
      await api(tab + (id ? '/' + encodeURIComponent(id) : ''), id ? 'PUT' : 'POST', data);
      await refresh();
      onClose();
    });
  }
  return (
    <Modal
      title={(id ? '编辑' : '添加') + tabs[tab]}
      onClose={() => {
        if (!feedback.busy) onClose();
      }}
    >
      <form onSubmit={submit}>
        <fieldset disabled={feedback.busy}>
          <div className="form-grid">
            <Field name="name" label="显示名称">
              <input id="name" name="name" required defaultValue={item?.name} autoFocus />
            </Field>
            <Field name="id" label="标识（英文、数字或连字符）">
              <input
                id="id"
                name="id"
                required
                readOnly={Boolean(id)}
                defaultValue={id}
                pattern="[A-Za-z0-9][A-Za-z0-9._\-]*"
                placeholder="my-connection"
              />
            </Field>
            {tab === 'connections' && (
              <>
                <Field name="kind" label="协议或 CLI">
                  <select
                    id="kind"
                    value={kind}
                    onChange={(e) => setKind(e.target.value as Connection['kind'])}
                  >
                    {Object.entries(protocols).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field name="poolId" label="共享额度池">
                  <select id="poolId" name="poolId" defaultValue={connection?.poolId ?? ''}>
                    <option value="">此连接独享</option>
                    {catalog.pools.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </Field>
                {cli(kind) ? (
                  <>
                    <Field name="executable" label="可执行文件绝对路径">
                      <input
                        id="executable"
                        name="executable"
                        defaultValue={cliConnection?.executable}
                        placeholder="留空则从 PATH 查找"
                      />
                    </Field>
                    <Field name="actionChannel" label="调度动作通道">
                      <select
                        id="actionChannel"
                        name="actionChannel"
                        defaultValue={
                          cliConnection && 'actionChannel' in cliConnection
                            ? String(cliConnection.actionChannel ?? '')
                            : ''
                        }
                      >
                        <option value="">自动检测</option>
                        <option value="mcp">本机 MCP</option>
                        <option value="json">受限 JSON 文本</option>
                      </select>
                    </Field>
                    <Field name="cwd" label="工作目录">
                      <input
                        id="cwd"
                        name="cwd"
                        defaultValue={cliConnection?.cwd}
                        placeholder="留空则使用临时目录"
                      />
                    </Field>
                  </>
                ) : (
                  <>
                    <Field name="baseUrl" label="API 根地址">
                      <input
                        id="baseUrl"
                        name="baseUrl"
                        type="url"
                        required
                        defaultValue={apiConnection?.baseUrl}
                        placeholder="https://gateway.example/v1"
                      />
                    </Field>
                    <Field name="credentialRef" label="系统凭据引用">
                      <input
                        id="credentialRef"
                        name="credentialRef"
                        pattern="keychain:[A-Za-z0-9._\-]+"
                        defaultValue={apiConnection?.credentialRef}
                        placeholder="keychain:my-gateway"
                        autoComplete="off"
                      />
                    </Field>
                  </>
                )}
              </>
            )}
            {(tab === 'pools' || tab === 'connections') && (
              <Field name="maxConcurrent" label="最大并发数">
                <input
                  id="maxConcurrent"
                  name="maxConcurrent"
                  type="number"
                  min="1"
                  required
                  defaultValue={(tab === 'pools' ? pool : connection)?.maxConcurrent ?? 1}
                />
              </Field>
            )}
            {(tab === 'models' || tab === 'members') && (
              <Field name="connectionId" label="连接">
                <select
                  id="connectionId"
                  value={connectionId}
                  required
                  onChange={(e) => setConnectionId(e.target.value)}
                >
                  <option value="">选择连接</option>
                  {catalog.connections.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                      {c.enabled ? '' : '（已禁用）'}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            {tab === 'models' && (
              <Field name="modelId" label="供应方模型 ID">
                <input
                  id="modelId"
                  name="modelId"
                  required
                  defaultValue={model?.modelId}
                  placeholder="输入网关或 CLI 的模型名"
                />
              </Field>
            )}
            {tab === 'members' && (
              <>
                <Field name="role" label="岗位职责">
                  <input
                    id="role"
                    name="role"
                    required
                    defaultValue={member?.role}
                    placeholder="如：后端开发"
                  />
                </Field>
                <Field name="modelId" label="模型">
                  <select
                    id="modelId"
                    key={connectionId}
                    name="modelId"
                    defaultValue={member?.connectionId === connectionId ? member.modelId : ''}
                    required={
                      !cli(
                        catalog.connections.find((c) => c.id === connectionId)?.kind ?? 'chat-completions',
                      )
                    }
                  >
                    <option value="">使用 CLI 默认模型</option>
                    {selectable.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name} · {m.modelId}
                      </option>
                    ))}
                  </select>
                </Field>
              </>
            )}
          </div>
          {tab === 'models' && (
            <details className="advanced">
              <summary>模型价格（可选）</summary>
              <div className="form-grid">
                <Field name="currency" label="币种代码">
                  <input
                    id="currency"
                    name="currency"
                    pattern="[A-Za-z]{3}"
                    maxLength={3}
                    defaultValue={model?.pricing?.currency}
                    placeholder="如 CNY 或 USD"
                  />
                </Field>
                <Field name="inputPerMillion" label="每百万输入 token 单价">
                  <input
                    id="inputPerMillion"
                    name="inputPerMillion"
                    type="number"
                    step="any"
                    min="0"
                    defaultValue={model?.pricing?.inputPerMillion}
                  />
                </Field>
                <Field name="outputPerMillion" label="每百万输出 token 单价">
                  <input
                    id="outputPerMillion"
                    name="outputPerMillion"
                    type="number"
                    step="any"
                    min="0"
                    defaultValue={model?.pricing?.outputPerMillion}
                  />
                </Field>
              </div>
            </details>
          )}
          {((tab === 'connections' && !cli(kind)) || tab === 'models') && (
            <details className="advanced">
              <summary>高级调用参数</summary>
              <div className="form-grid">
                {tab === 'connections' && (
                  <>
                    <Field name="endpoint" label="自定义端点">
                      <input id="endpoint" name="endpoint" defaultValue={apiConnection?.endpoint} />
                    </Field>
                    <Field name="headerRefs" label="请求头凭据引用（JSON）">
                      <textarea
                        id="headerRefs"
                        name="headerRefs"
                        defaultValue={apiConnection?.headerRefs && JSON.stringify(apiConnection.headerRefs)}
                        placeholder='{"X-Custom-Key":"keychain:header"}'
                      />
                    </Field>
                    <Field name="timeoutMs" label="超时（毫秒）">
                      <input
                        id="timeoutMs"
                        type="number"
                        min="1"
                        name="timeoutMs"
                        defaultValue={apiConnection?.timeoutMs}
                      />
                    </Field>
                    <Field name="maxOutputTokens" label="最大输出 tokens">
                      <input
                        id="maxOutputTokens"
                        type="number"
                        min="1"
                        name="maxOutputTokens"
                        defaultValue={apiConnection?.maxOutputTokens}
                      />
                    </Field>
                  </>
                )}
                {tab === 'models' && (
                  <Field name="toolMode" label="动作通道">
                    <select
                      id="toolMode"
                      name="toolMode"
                      defaultValue={model && 'toolMode' in model ? String(model.toolMode) : 'native'}
                    >
                      <option value="native">原生工具</option>
                      <option value="json">结构化 JSON 文本</option>
                    </select>
                  </Field>
                )}
                <Field name="params" label="模型参数（JSON）">
                  <textarea
                    id="params"
                    name="params"
                    defaultValue={JSON.stringify(tab === 'models' ? model?.params : apiConnection?.params)}
                    placeholder='{"temperature":0.2}'
                  />
                </Field>
              </div>
            </details>
          )}
          {tab === 'members' && (
            <Field name="systemPrompt" label="岗位系统提示词">
              <textarea id="systemPrompt" name="systemPrompt" defaultValue={member?.systemPrompt} />
            </Field>
          )}
          {tab === 'members' && <MemberPermissions member={member} members={catalog.members} />}
          <Notice error={feedback.error} />
          <div className="modal-actions">
            <button type="button" onClick={onClose}>
              取消
            </button>
            <button className="primary">保存{tabs[tab]}</button>
          </div>
        </fieldset>
      </form>
    </Modal>
  );
}

interface Inspection {
  inspectionId: string;
  login?: string;
  billing?: string;
  version?: string;
  billingEnvironment?: { name: string; source: string; passed?: boolean }[];
  arguments?: string[];
}
interface TestResult {
  ok: boolean;
  text?: string;
  httpStatus?: number;
  elapsedMs?: number;
  error?: string;
}
function TestConnection({
  connection,
  models,
  member,
  close,
}: {
  connection: Connection;
  models: CatalogModel[];
  member?: Member;
  close: () => void;
}) {
  const isCli = cli(connection.kind);
  const [modelId, setModel] = useState(
    member ? (member.modelId ?? '') : isCli ? '' : (models[0]?.id ?? ''),
  );
  const [unmanaged, setUnmanaged] = useState(false);
  const [inspection, setInspection] = useState<Inspection>();
  const [result, setResult] = useState<TestResult>();
  const feedback = useAction();
  const path = member
    ? 'members/' + encodeURIComponent(member.id)
    : 'connections/' + encodeURIComponent(connection.id);
  const controller = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => controller.current?.abort(), []);
  async function probe<T>(mode: 'inspect' | 'test', data: object) {
    const current = new AbortController();
    controller.current = current;
    try {
      return await api<T>(path + '/' + mode, 'POST', data, current.signal);
    } finally {
      controller.current = undefined;
    }
  }
  const model = member || !modelId ? {} : { modelId };
  return (
    <Modal
      title={'验证 · ' + (member?.name ?? connection.name)}
      onClose={() => {
        controller.current?.abort();
        close();
      }}
    >
      <fieldset disabled={feedback.busy}>
        {isCli ? (
          <>
            {connection.kind === 'claude' && (
              <label className="check">
                <input
                  type="checkbox"
                  checked={unmanaged}
                  onChange={(e) => {
                    setUnmanaged(e.target.checked);
                    setInspection(undefined);
                  }}
                />
                已在 Claude Code 的 /status 核对无受管设置
              </label>
            )}
            <button
              onClick={() =>
                void feedback.run(async () => {
                  setResult(undefined);
                  setInspection(
                    await probe<Inspection>('inspect', {
                      confirmUnmanaged: unmanaged,
                      ...model,
                    }),
                  );
                })
              }
            >
              预检路径、版本和登录状态
            </button>
            {inspection && (
              <div className="surface compact">
                <p>
                  版本 {inspection.version ?? '未知'} · {inspection.login} · 计费来源{' '}
                  {inspection.billing ?? '未知'}
                </p>
                <ul>
                  {inspection.billingEnvironment?.map((e) => (
                    <li key={e.name}>
                      {e.name} · {e.source} · {e.passed ? '传入' : '忽略'}
                    </li>
                  ))}
                </ul>
                <details>
                  <summary>查看实际权限参数</summary>
                  <pre>{JSON.stringify(inspection.arguments, null, 2)}</pre>
                </details>
              </div>
            )}
          </>
        ) : null}
        <Field name="testModel" label="测试模型">
          <select
            id="testModel"
            disabled={Boolean(member)}
            value={modelId}
            onChange={(e) => {
              setModel(e.target.value);
              setResult(undefined);
              setInspection(undefined);
            }}
          >
            <option value="">{isCli ? 'CLI 默认' : '选择已启用模型'}</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} · {m.modelId}
              </option>
            ))}
          </select>
        </Field>
        <p className="help">此操作向所选连接发送一次只读请求，可能产生费用或消耗订阅额度。</p>
        <Notice
          error={feedback.error || result?.error}
          message={
            result?.ok
              ? [
                  result.text,
                  result.httpStatus && 'HTTP ' + result.httpStatus,
                  result.elapsedMs != null && result.elapsedMs + ' ms',
                ]
                  .filter(Boolean)
                  .join(' · ')
              : ''
          }
        />
        <div className="modal-actions">
          <button onClick={close}>关闭</button>
          <button
            className="primary"
            disabled={isCli ? !inspection || (connection.kind === 'claude' && !unmanaged) : !modelId}
            onClick={() =>
              void feedback.run(async () => {
                setResult(undefined);
                setResult(
                  await probe<TestResult>('test', {
                    approved: true,
                    ...model,
                    ...(isCli && { inspectionId: inspection?.inspectionId, confirmUnmanaged: unmanaged }),
                  }),
                );
              })
            }
          >
            批准一次真实调用
          </button>
        </div>
      </fieldset>
      {feedback.busy && (
        <button className="danger" onClick={() => controller.current?.abort()}>
          取消连接验证
        </button>
      )}
    </Modal>
  );
}

export function CatalogPage() {
  const resource = useResource<Catalog>('catalog');
  const feedback = useAction();
  const [tab, setTab] = useState<Tab>('connections');
  const [editor, setEditor] = useState<{ id?: string }>();
  const [test, setTest] = useState<{ connection: Connection; member?: Member }>();
  const [remove, setRemove] = useState<{ id: string; name: string }>();
  const catalog = resource.data;
  const rows: Row[] = catalog?.[tab] ?? [];
  function detail(item: Connection | CatalogModel | Member | QuotaPool) {
    if (isConnection(item))
      return (
        protocols[item.kind] +
        ' · ' +
        ('baseUrl' in item ? item.baseUrl : item.executable || '自动探测程序路径')
      );
    if ('connectionId' in item)
      return (
        ('role' in item ? item.role : item.modelId) +
        ' · ' +
        (catalog?.connections.find((c) => c.id === item.connectionId)?.name ?? item.connectionId)
      );
    return '最大并发 ' + item.maxConcurrent;
  }
  return (
    <>
      <header className="page-title">
        <div>
          <h1>连接与成员</h1>
          <p>为团队设置模型来源、岗位和共享调用额度。</p>
        </div>
        <button className="primary" onClick={() => setEditor({})} disabled={!catalog}>
          ＋ 添加{tabs[tab]}
        </button>
      </header>
      <nav className="tabs" aria-label="配置类型">
        {(Object.keys(tabs) as Tab[]).map((key) => (
          <button key={key} aria-current={tab === key ? 'page' : undefined} onClick={() => setTab(key)}>
            {tabs[key]} <small>{catalog?.[key].length ?? '—'}</small>
          </button>
        ))}
      </nav>
      <Notice error={resource.error || feedback.error} message={feedback.message} />
      {catalog && (
        <section className="surface">
          <div className="section-head">
            <h2>{tabs[tab]}列表</h2>
            <span>{rows.length} 项</span>
          </div>
          {rows.length ? (
            rows.map((item) => (
              <article className="record" key={item.id}>
                <div
                  className={'mark ' + (isConnection(item) && cli(item.kind) ? 'cli' : '')}
                  aria-hidden="true"
                >
                  {isConnection(item)
                    ? item.kind === 'claude'
                      ? 'C'
                      : item.kind === 'codex'
                        ? '›_'
                        : '↗'
                    : tab === 'members'
                      ? '人'
                      : tab === 'models'
                        ? 'M'
                        : '∥'}
                </div>
                <div className="record-info">
                  <h3>
                    {item.name}{' '}
                    {'enabled' in item && (
                      <span className={'tag ' + (item.enabled ? 'on' : '')}>
                        {item.enabled ? '已启用' : '已禁用'}
                      </span>
                    )}
                  </h3>
                  <p>{detail(item)}</p>
                </div>
                <div className="actions">
                  {isConnection(item) && (
                    <button disabled={!item.enabled} onClick={() => setTest({ connection: item })}>
                      验证
                    </button>
                  )}
                  {isMember(item) && (
                    <button
                      disabled={
                        !item.enabled ||
                        !catalog.connections.some((c) => c.id === item.connectionId && c.enabled)
                      }
                      onClick={() => {
                        const connection = catalog.connections.find((c) => c.id === item.connectionId);
                        if (connection) setTest({ connection, member: item });
                      }}
                    >
                      验证
                    </button>
                  )}
                  <button onClick={() => setEditor({ id: item.id })}>编辑</button>
                  {'enabled' in item && (
                    <button
                      disabled={feedback.busy}
                      onClick={() =>
                        void feedback.run(async () => {
                          await api(tab + '/' + encodeURIComponent(item.id), 'PUT', {
                            ...item,
                            enabled: !item.enabled,
                          });
                          await resource.reload();
                        })
                      }
                    >
                      {item.enabled ? '禁用' : '启用'}
                    </button>
                  )}
                  <button className="text-button danger" onClick={() => setRemove(item)}>
                    删除
                  </button>
                </div>
              </article>
            ))
          ) : (
            <Empty>
              <strong>尚无{tabs[tab]}</strong>
              <p>
                {tab === 'connections'
                  ? '添加已登录的 CLI 或自定义 API 网关，随后可按需授权验证。'
                  : tab === 'pools'
                    ? '使用同一订阅或网关账户的连接可以共享并发上限。'
                    : '先添加连接，再设置模型和负责该岗位的成员。'}
              </p>
            </Empty>
          )}
        </section>
      )}
      {catalog && editor && (
        <Editor
          tab={tab}
          catalog={catalog}
          id={editor.id}
          onClose={() => setEditor(undefined)}
          refresh={resource.reload}
        />
      )}
      {catalog && test && (
        <TestConnection
          connection={test.connection}
          member={test.member}
          models={catalog.models.filter((m) => m.connectionId === test.connection.id && m.enabled)}
          close={() => setTest(undefined)}
        />
      )}
      {remove && (
        <Modal title={'删除' + tabs[tab]} onClose={() => setRemove(undefined)}>
          <p>确定删除「{remove.name}」？</p>
          <Notice error={feedback.error} />
          <div className="modal-actions">
            <button onClick={() => setRemove(undefined)}>取消</button>
            <button
              className="danger"
              disabled={feedback.busy}
              onClick={() =>
                void feedback.run(async () => {
                  await api(tab + '/' + encodeURIComponent(remove.id), 'DELETE');
                  setRemove(undefined);
                  await resource.reload();
                })
              }
            >
              确认删除
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
