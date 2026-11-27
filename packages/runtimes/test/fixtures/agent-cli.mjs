import { randomUUID } from 'node:crypto';
import { text } from 'node:stream/consumers';
const [kind, ...args] = process.argv.slice(2);
const claude = kind === 'claude';
const option = name => args[args.indexOf(name) + 1];
const tomlUrl = args.find(a => a.startsWith('mcp_servers='))?.match(/url="([^"]+)"/)?.[1];
if (args.includes('--version')) console.log(claude ? '2.1.330 (Claude Code)' : 'codex-cli 0.171.0');
else if (args.includes('--help')) {
  let help='--no-daemon --disable --ask-for-approval --sandbox --ephemeral --skip-git-repo-check --json resume --resume --session-id --verbose --restricted --print --output-format --safe-mode --permission-mode --tools --allowedTools --disallowedTools --strict-mcp-config --mcp-config --max-turns --no-session-persistence --settings --model';
  if(process.env.LANG==='synthetic-legacy') help=help.split(' ').filter(x => !['--mcp-config','--allowedTools'].includes(x)).join(' ');
  console.log(help);
} else if (args.includes('features')) {
  args.forEach((arg, i) => { if (arg === '--disable') console.log(args[i + 1] + ' stable false'); });
} else if (args.includes('list')) {
  console.log(JSON.stringify(tomlUrl ? [{ name: 'concordia', enabled: true, transport: {
    type: 'streamable_http', url: tomlUrl, bearer_token_env_var: 'CONCORDIA_MCP_TOKEN',
  } }] : []));
} else if (args.includes('status')) {
  if (claude) console.log('{"loggedIn":true,"authMethod":"claude.ai"}');
  else console.log('Logged in using ChatGPT');
} else {
  const prompt = await text(process.stdin);
  const token = process.env.CONCORDIA_MCP_TOKEN;
  const remote = args.includes('--mcp-config') || Boolean(tomlUrl);
  if (Boolean(token) !== remote || args.some(arg => (token && arg.includes(token)) || arg === prompt)) process.exit(2);
  const resume = args.includes(claude ? '--resume' : 'resume');
  const session = resume ? option(claude ? '--resume' : 'resume') : (claude ? option('--session-id') : randomUUID());
  const init = claude ? {type:'system',subtype:'init',session_id:session} : {type:'thread.started',thread_id:session};
  console.log(JSON.stringify(init));
  if(prompt==='interrupt') await new Promise(resolve=>setTimeout(resolve,60_000));
  let result = (resume ? 'resumed ' : 'new ') + session;
  if (remote) {
  let url = tomlUrl;
  if (claude) {
    const config = JSON.parse(option('--mcp-config')).mcpServers.concordia;
    if (config.headers.Authorization !== 'Bearer ${CONCORDIA_MCP_TOKEN}') process.exit(3);
    url = config.url;
  }
  async function rpc(id, method, params, requireDenial = false) {
    const response = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    const payload = await response.json();
    if (requireDenial) {
      if (!payload.error) process.exit(10);
      return;
    }
    if (!response.ok || payload.error || payload.result?.isError) process.exit(4);
    return payload.result;
  }
  await rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake', version: '1' } });
  const list = await rpc(2,'tools/list',{});
  if (!list.tools.some(t => t.name === 'publish_artifact')) process.exit(5);
  const write = prompt === '受控写';
  if (list.tools.some(t => t.name === 'write_file') !== write) process.exit(6);
  if (claude && option('--tools') !== '') process.exit(7);
  if (!claude && (option('--sandbox') !== (write ? 'workspace-write' : 'read-only') || !args.includes('shell_tool'))) process.exit(8);
  if (write && !claude && !args.includes('sandbox_workspace_write.exclude_slash_tmp=true')) process.exit(9);
  await rpc(3, 'tools/call', { name: 'publish_artifact', arguments: { slotId: 'contract', content: prompt } });
  await rpc(4, 'tools/call', { name: 'write_file', arguments: { path: 'src/demo.ts', content: '测试内容' } }, !write);
  } else {
    if (claude && (option('--tools') !== '' || option('--disallowedTools') !== '*')) process.exit(11);
    if (!claude && option('--sandbox') !== 'read-only') process.exit(12);
    if (prompt === '生成计划') {
      result='单次输出';
    } else {
      const {task,tools}=JSON.parse(prompt);
      if(!tools.some(tool=>tool.name==='submit_result')) process.exit(13);
      result=JSON.stringify({actions:[{type:'submit_result',summary:task}]});
    }
  }
  if (claude) console.log(JSON.stringify({ type:'result',subtype:'success',is_error:false,result,session_id:session,usage:{input_tokens:3,output_tokens:2} }));
  else {
    for (const event of [
      { type:'turn.started' },
      { type:'item.completed',item:{type:'agent_message',text:result} },
      { type:'turn.completed',usage:{input_tokens:3,output_tokens:2} },
    ]) console.log(JSON.stringify(event));
  }
}
