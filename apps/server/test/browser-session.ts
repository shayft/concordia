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
  const headers = { cookie, origin, 'x-concordia-session': proof };
  const get = (path: string) => fetch(origin + path, { headers });
  async function send(path: string, body: unknown, method = 'POST') {
    const workspace = await (await get('/api/workspaces')).json() as { active: string; generation: string };
    const scope = { 'x-concordia-workspace': workspace.active, 'x-concordia-generation': workspace.generation };
    return fetch(origin + path, { method, headers: { ...headers, ...scope, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  }
  return { origin, cookie, headers, get, post: send };
}
