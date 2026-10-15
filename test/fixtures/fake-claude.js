// Stand-in for the Claude Code CLI used by the tests. Records how it was
// called (args, stdin, whether an API key leaked into its env) and replies
// in Claude Code's stream-json format.
const fs = require('fs');

const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('9.9.9 (Claude Code)');
  process.exit(0);
}

let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  const msg = JSON.parse(input.trim());
  fs.appendFileSync(
    process.env.FAKE_CLAUDE_LOG,
    JSON.stringify({ args, msg, hasApiKey: 'ANTHROPIC_API_KEY' in process.env, cwd: process.cwd() }) + '\n',
  );
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  out({ type: 'system', subtype: 'init', tools: [] });

  const text = msg.message.content.map((c) => c.text || '').join(' ');
  if (text.includes('LOGIN_FAIL')) {
    out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Not logged in · Please run /login' }] } });
    out({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login' });
    process.exit(1);
  }

  const reply = ['Good ', 'diagram! ', '**Next:** ', 'explain Vth.'];
  for (const t of reply) {
    out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } } });
  }
  out({ type: 'assistant', message: { content: [{ type: 'text', text: reply.join('') }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: reply.join('') });
});
