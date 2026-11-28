/** A native test client following the same local browser exchange as /launch. */
export async function browserSession(url: URL) {
  const { origin } = url;
  const exchange = await fetch(origin + '/session', {
    method: 'POST', headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ token: url.hash.slice(1) }),
  });
  const cookie = exchange.headers.get('set-cookie')?.split(';')[0];
  const proof = exchange.headers.get('x-concordia-session');
  if (exchange.status !== 204 || !cookie || !proof) throw new Error('测试客户端未能建立会话');
  return browserTab(origin, cookie, proof);
}

/** Another tab has the same origin storage and cookie jar, with independent request handlers. */
function browserTab(origin: string, cookie: string, proof: string) {
  const headers = { cookie, origin, 'x-concordia-session': proof };
  const get = (path: string) => fetch(origin + path, { headers });
  async function send(path: string, body: unknown, method = 'POST', reviewedStamp?: string) {
    const input = (body ?? {}) as Record<string, unknown>;
    const [, , resource, id, op] = path.split('/');
    let purpose: string | undefined;
    if (input.approved === true) {
      if (resource === 'tasks' && op === 'run' && input.mode === 'live') purpose = 'task';
      if (resource === 'plans' && id === 'generate') purpose = 'plan';
      if (resource === 'dispatch') purpose = 'dispatch';
      if (op === 'test' && resource === 'connections') purpose = 'connection-test';
      if (op === 'test' && resource === 'members') purpose = 'member-test';
    }
    const approval: Record<string,string> = {};
    if (purpose) {
      const query = new URLSearchParams({ purpose });
      if (typeof input.maxCalls === 'number') query.set('maxCalls', String(input.maxCalls));
      if (purpose === 'plan' && Array.isArray(input.members)) query.set('roster', input.members.join(','));
      if (purpose !== 'dispatch') query.set('id', purpose === 'plan' ? String(input.agentId) : decodeURIComponent(id));
      for (const key of ['modelId', 'projectId', 'treeId'])
        if (typeof input[key] === 'string') query.set(key, input[key]);
      const stamp = reviewedStamp ?? (await (await get('/api/approval-route?' + query)).json()).stamp;
      if (stamp) approval['x-concordia-approval'] = stamp;
    }
    const workspace = await (await get('/api/workspaces')).json() as { active: string; generation: string };
    const scope = { 'x-concordia-workspace': workspace.active, 'x-concordia-generation': workspace.generation };
    return fetch(origin + path, { method, headers: { ...headers, ...scope, ...approval, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  }
  return { origin, cookie, headers, get, post: send, openTab: () => browserTab(origin, cookie, proof) };
}
