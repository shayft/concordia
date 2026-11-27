// Invoked only from tests, copied under the selected CLI name with a Node shebang.
const { basename } = require('node:path');
const args = process.argv.slice(2);
const kind = basename(process.argv[1]);
const claude = kind === 'claude';
if (args.includes('--version')) {
  console.log(claude ? '1.2.3 (Claude Code)' : 'codex-cli 1.2.3');
} else if (args.includes('--help')) {
  console.log('--print --output-format --safe-mode --permission-mode --tools --disallowedTools --strict-mcp-config --max-turns --no-session-persistence --settings --no-daemon --disable --ask-for-approval --sandbox --ephemeral --skip-git-repo-check --json --model');
} else if (args.includes('status')) {
  if (claude) console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', account: 'OMITTED_MARKER' }));
  else console.error('Logged in using ChatGPT');
} else if (args.includes('features')) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--disable') console.log(args[i + 1] + '  stable  false');
  }
} else if (args.includes('list')) {
  console.log('[]');
} else {
  if (process.env.OPENAI_API_KEY !== undefined || process.env.UNLISTED_DEMO !== undefined) process.exit(3);
  if (process.env.PATH !== '/usr/bin:/bin:/usr/sbin:/sbin') process.exit(4);
  if (basename(process.cwd()) !== 'working dir') process.exit(5);
  if (!args.at(-1)?.startsWith('Reply with exactly CONCORDIA_OK')) process.exit(6);
  if (claude) {
    if (args[args.indexOf('--tools') + 1] !== '' || args[args.indexOf('--disallowedTools') + 1] !== '*') process.exit(7);
    console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'CONCORDIA_OK', session_id: 'OMITTED_MARKER' }));
  } else {
    if (args[args.indexOf('--sandbox') + 1] !== 'read-only' || !args.includes('--json')) process.exit(8);
    console.log('{"type":"thread.started","thread_id":"OMITTED_MARKER"}');
    console.log('{"type":"turn.started"}');
    console.log('{"type":"item.completed","item":{"type":"agent_message","text":"CONCORDIA_OK"}}');
    console.log('{"type":"turn.completed"}');
  }
}
