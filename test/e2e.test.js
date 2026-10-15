// End-to-end tests: launch the real Electron app, drive it with Playwright,
// and point it at mock Ollama / Claude servers (no real AI or API key needed).
//
//   npm test                 (Windows / macOS)
//   xvfb-run -a npm test     (Linux without a display)
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright-core');

const ROOT = path.join(__dirname, '..');
const ELECTRON = require('electron'); // path to the Electron binary when required from Node

// ---------- mock servers ----------
const ollama = { requests: [], server: null, url: '' };
const claude = { requests: [], server: null, url: '' };

function startOllamaMock() {
  return new Promise((resolve) => {
    ollama.server = http.createServer((req, res) => {
      if (req.url === '/api/tags') {
        res.end(JSON.stringify({ models: [{ name: 'qwen2.5vl:7b' }, { name: 'llama3.2' }] }));
        return;
      }
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        const j = JSON.parse(body);
        ollama.requests.push(j);
        const last = j.messages.at(-1);
        const slow = last.content.includes('SLOW');
        const reply = slow
          ? 'word '.repeat(200)
          : `**Reply ${ollama.requests.length}.** Last message ${last.images ? 'had' : 'had no'} image.`;
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        const parts = reply.match(/.{1,6}/gs);
        let i = 0;
        const t = setInterval(() => {
          if (res.destroyed) return clearInterval(t);
          if (i < parts.length) res.write(JSON.stringify({ message: { content: parts[i++] } }) + '\n');
          else {
            res.end(JSON.stringify({ done: true }) + '\n');
            clearInterval(t);
          }
        }, slow ? 100 : 5);
        res.on('close', () => clearInterval(t));
      });
    });
    ollama.server.listen(0, '127.0.0.1', () => {
      ollama.url = `http://127.0.0.1:${ollama.server.address().port}`;
      resolve();
    });
  });
}

function startClaudeMock() {
  return new Promise((resolve) => {
    claude.server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        claude.requests.push({ url: req.url, headers: req.headers, body: JSON.parse(body) });
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const ev = (type, d) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...d })}\n\n`);
        ev('message_start', {
          message: { id: 'm1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } },
        });
        ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
        ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Correct! ' } });
        ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Next question: what is Vth?' } });
        ev('content_block_stop', { index: 0 });
        ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } });
        ev('message_stop', {});
        res.end();
      });
    });
    claude.server.listen(0, '127.0.0.1', () => {
      claude.url = `http://127.0.0.1:${claude.server.address().port}`;
      resolve();
    });
  });
}

before(async () => {
  await startOllamaMock();
  await startClaudeMock();
});
after(() => {
  ollama.server.close();
  claude.server.close();
});

// ---------- helpers ----------
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wbt-test-'));

async function launch(dataDir, env = {}) {
  const args = [ROOT];
  if (process.platform === 'linux') args.push('--no-sandbox');
  const app = await _electron.launch({
    executablePath: ELECTRON,
    args,
    env: { ...process.env, ANTHROPIC_API_KEY: '', WHITEBOARD_TUTOR_DATA_DIR: dataDir, ...env },
  });
  const win = await app.firstWindow();
  const errors = [];
  win.on('pageerror', (e) => errors.push(e.message));
  await win.waitForSelector('#board canvas');
  await win.waitForFunction(() => document.querySelector('#sessionTitle').textContent !== '');
  return { app, win, errors };
}

// Writes settings straight to the data dir so tests can skip the dialog.
function writeSettings(dataDir, s) {
  fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify(s));
}

async function closeDialogs(win) {
  await win.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
}

async function drag(win, from, to) {
  const box = await win.locator('#board canvas').boundingBox();
  await win.mouse.move(box.x + from[0], box.y + from[1]);
  await win.mouse.down();
  await win.mouse.move(box.x + to[0], box.y + to[1], { steps: 8 });
  await win.mouse.up();
}

const objectCount = (win) => win.evaluate(() => board.serialize().length);
// Waits for the n-th finished AI reply; on timeout, includes the chat text to show what went wrong.
async function assistantDone(win, n) {
  try {
    await win.waitForFunction((n) => document.querySelectorAll('.msg.assistant:not(.typing)').length >= n, n, { timeout: 15000 });
  } catch (e) {
    throw new Error(`${e.message}\nChat was:\n${await win.locator('#messages').innerText()}`);
  }
}

// ---------- tests ----------
const shared = tmpDir(); // used by the Ollama tests, which build on each other

test('first launch opens Settings, lists Ollama models, and saves the choice', async () => {
  const { app, win, errors } = await launch(shared);
  try {
    assert.ok(await win.locator('#settings[open]').isVisible(), 'settings dialog should open on first run');
    await win.fill('#ollamaUrl', ollama.url);
    await win.click('#refreshModels');
    await win.waitForFunction(() => document.querySelectorAll('#ollamaModel option').length === 2);
    await win.selectOption('#ollamaModel', 'qwen2.5vl:7b');
    await win.click('#saveSettings');
    await win.waitForFunction(() => document.querySelector('#providerBadge').textContent.includes('qwen2.5vl'));
    assert.deepEqual(errors, []);
  } finally {
    await app.close();
  }
});

test('drawing + text sends a cropped PNG snapshot and renders the streamed reply', async () => {
  const { app, win, errors } = await launch(shared);
  try {
    ollama.requests.length = 0;
    await win.keyboard.press('r');
    await drag(win, [100, 200], [400, 300]);
    await win.keyboard.press('t');
    const box = await win.locator('#board canvas').boundingBox();
    await win.mouse.click(box.x + 150, box.y + 240);
    await win.keyboard.type('p-substrate');
    await win.keyboard.press('Enter');
    assert.equal(await objectCount(win), 2);

    await win.fill('#input', 'Act as a VLSI interviewer. Here is my answer.');
    await win.press('#input', 'Enter');
    await assistantDone(win, 1);

    const req = ollama.requests.at(-1);
    assert.equal(req.model, 'qwen2.5vl:7b');
    assert.equal(req.messages[0].role, 'system');
    const last = req.messages.at(-1);
    assert.match(last.content, /VLSI interviewer/);
    assert.equal(last.images.length, 1);
    const png = Buffer.from(last.images[0], 'base64');
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    // cropped to the drawing (~300x100 + padding, upscaled at most 2x), not the full board
    const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
    assert.ok(w < 900 && h < 400, `snapshot should be cropped, got ${w}x${h}`);

    const html = await win.locator('.msg.assistant').last().innerHTML();
    assert.match(html, /<strong>Reply \d+\.<\/strong>/, 'markdown should render');
    assert.equal(await win.locator('.msg.user img.snap').count(), 1, 'user bubble shows the snapshot');
    assert.deepEqual(errors, []);
  } finally {
    await app.close();
  }
});

test('Next question clears the board, sends no image, and Ctrl+Z restores the drawing', async () => {
  const { app, win, errors } = await launch(shared);
  try {
    ollama.requests.length = 0;
    assert.equal(await objectCount(win), 2, 'board from previous test was restored');
    await win.fill('#input', 'half-typed draft');
    const before = await win.locator('.msg.assistant').count();

    await win.click('#nextQuestion');
    assert.equal(await objectCount(win), 0, 'board cleared');
    await assistantDone(win, before + 1);

    const req = ollama.requests.at(-1);
    const last = req.messages.at(-1);
    assert.equal(last.content, 'Next question, please.');
    assert.equal(last.images, undefined, 'no image with Next question');
    // the earlier snapshot is replaced by a note so only the newest image is ever sent
    assert.ok(req.messages.every((m) => !m.images));
    assert.ok(req.messages.some((m) => m.content.includes('[An earlier whiteboard snapshot was attached here.]')));
    assert.equal(await win.inputValue('#input'), 'half-typed draft', 'draft is kept');
    assert.equal(await win.locator('.msg.user').last().textContent(), 'Next question, please.');

    await win.locator('#board canvas').click({ position: { x: 5, y: 5 }, button: 'right' }); // move focus off the input
    await win.evaluate(() => document.activeElement.blur());
    await win.keyboard.press('Control+z');
    assert.equal(await objectCount(win), 2, 'undo brings the cleared drawing back');
    assert.deepEqual(errors, []);
  } finally {
    await app.close();
  }
});

test('Stop cancels a streaming reply, keeps the partial text, and Next question is disabled meanwhile', async () => {
  const { app, win, errors } = await launch(shared);
  try {
    const before = await win.locator('.msg.assistant').count();
    await win.fill('#input', 'SLOW please');
    await win.press('#input', 'Enter');
    await win.waitForFunction(() => document.querySelector('.msg.assistant.typing')?.textContent.length > 10);
    assert.ok(await win.locator('#nextQuestion').isDisabled());
    assert.equal(await win.textContent('#send'), 'Stop');

    await win.click('#send');
    await assistantDone(win, before + 1);
    assert.match(await win.locator('.msg.assistant').last().textContent(), /word.*\(stopped\)/s);
    assert.equal(await win.textContent('#send'), 'Send');
    assert.ok(await win.locator('#nextQuestion').isEnabled());
    assert.deepEqual(errors, []);
  } finally {
    await app.close();
  }
});

test('sessions persist across restarts and can be deleted', async () => {
  const { app, win, errors } = await launch(shared);
  try {
    const sessions = await win.evaluate(() => window.api.listSessions());
    assert.equal(sessions.length, 1);
    assert.match(sessions[0].title, /VLSI interviewer/);
    // 3 user + 3 assistant turns from the previous tests
    assert.equal(await win.locator('.msg.user').count(), 3);
    assert.equal(await win.locator('.msg.assistant').count(), 3);

    await win.click('#newSession');
    await drag(win, [50, 50], [200, 120]);
    await win.waitForFunction(async () => (await window.api.listSessions()).length === 2, null, { timeout: 5000 });
    await win.locator('#sessionList li').nth(1).click(); // older session
    await win.waitForFunction(() => document.querySelectorAll('.msg.user').length === 3);

    win.once('dialog', (d) => d.accept());
    await win.locator('#sessionList li').first().hover();
    await win.locator('#sessionList li').first().locator('.del').click();
    await win.waitForFunction(async () => (await window.api.listSessions()).length === 1);
    assert.deepEqual(errors, []);
  } finally {
    await app.close();
  }
});

test('Claude without an API key shows a friendly error', async () => {
  const dir = tmpDir();
  writeSettings(dir, { provider: 'claude' });
  const { app, win, errors } = await launch(dir);
  try {
    await closeDialogs(win);
    await win.fill('#input', 'hello');
    await win.press('#input', 'Enter');
    await win.waitForSelector('.msg.error');
    assert.equal(await win.textContent('.msg.error'), 'No Claude API key set. Add one in Settings.');
    assert.deepEqual(errors, []);
  } finally {
    await app.close();
  }
});

test('Claude request carries the board image, model, adaptive thinking, effort and fallbacks', async () => {
  const dir = tmpDir();
  writeSettings(dir, { provider: 'claude', claudeEffort: 'high' });
  const { app, win, errors } = await launch(dir, { ANTHROPIC_API_KEY: 'sk-ant-test', ANTHROPIC_BASE_URL: claude.url });
  try {
    await closeDialogs(win);
    await drag(win, [100, 100], [300, 200]);
    await win.fill('#input', 'my answer');
    await win.press('#input', 'Enter');
    await assistantDone(win, 1);
    assert.equal((await win.locator('.msg.assistant').last().textContent()).trim(), 'Correct! Next question: what is Vth?');

    const { headers, body } = claude.requests.at(-1);
    assert.equal(headers['x-api-key'], 'sk-ant-test');
    assert.match(headers['anthropic-beta'], /server-side-fallback-2026-07-01/);
    assert.equal(body.model, 'claude-opus-5-5');
    assert.deepEqual(body.thinking, { type: 'adaptive' });
    assert.deepEqual(body.output_config, { effort: 'high' });
    assert.equal(body.fallbacks, 'default');
    assert.equal(body.stream, true);
    const content = body.messages.at(-1).content;
    assert.equal(content[0].type, 'image');
    assert.equal(content[0].source.media_type, 'image/png');
    assert.equal(content[1].text, 'my answer');

    // Next question via Claude: no image block, plain text
    await win.click('#nextQuestion');
    await assistantDone(win, 2);
    const next = claude.requests.at(-1).body.messages.at(-1).content;
    assert.deepEqual(next, [{ type: 'text', text: 'Next question, please.' }]);
    assert.deepEqual(errors, []);
  } finally {
    await app.close();
  }
});

// ---------- Claude Pro / Max via Claude Code ----------
// Makes a "claude" command that runs the fake CLI (a .cmd shim on Windows, like npm creates).
function fakeClaudeCommand(dir) {
  const script = path.join(__dirname, 'fixtures', 'fake-claude.js');
  if (process.platform === 'win32') {
    const f = path.join(dir, 'claude.cmd');
    fs.writeFileSync(f, `@node "${script}" %*\r\n`);
    return f;
  }
  const f = path.join(dir, 'claude');
  fs.writeFileSync(f, `#!/bin/sh\nexec node "${script}" "$@"\n`, { mode: 0o755 });
  return f;
}
const readLog = (f) => fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('Claude Pro via Claude Code: streams the reply, sends the board and history, tools off, no API key', async () => {
  const dir = tmpDir();
  const log = path.join(dir, 'calls.log');
  writeSettings(dir, { provider: 'claudecode', claudeCodePath: fakeClaudeCommand(dir), claudeCodeModel: 'opus' });
  // a key in the environment must NOT reach Claude Code, or it would bill the API instead of the plan
  const { app, win, errors } = await launch(dir, { ANTHROPIC_API_KEY: 'sk-must-not-leak', FAKE_CLAUDE_LOG: log });
  try {
    assert.equal(await win.locator('#settings[open]').count(), 0, 'no settings prompt for this provider');
    assert.equal(await win.textContent('#providerBadge'), 'Claude Pro · Opus');
    await drag(win, [100, 100], [300, 200]);
    await win.fill('#input', 'Interview me on VLSI. My first drawing.');
    await win.press('#input', 'Enter');
    await assistantDone(win, 1);
    assert.match(await win.locator('.msg.assistant').last().innerHTML(), /Good diagram! <strong>Next:<\/strong> explain Vth\./);

    let call = readLog(log).at(-1);
    assert.equal(call.hasApiKey, false);
    const a = call.args;
    assert.ok(a.includes('-p'));
    assert.equal(a[a.indexOf('--tools') + 1], '', 'all tools disabled');
    assert.equal(a[a.indexOf('--model') + 1], 'opus');
    assert.equal(a[a.indexOf('--input-format') + 1], 'stream-json');
    assert.ok(fs.readFileSync(a[a.indexOf('--system-prompt-file') + 1], 'utf8').includes('whiteboard'));
    const c = call.msg.message.content;
    assert.equal(c[0].type, 'image');
    assert.equal(c[0].source.media_type, 'image/png');
    assert.equal(c[1].text, 'Interview me on VLSI. My first drawing.');

    // second turn: earlier turns arrive as a transcript; Next question sends no image
    await win.click('#nextQuestion');
    await assistantDone(win, 2);
    call = readLog(log).at(-1);
    const c2 = call.msg.message.content;
    assert.equal(c2.length, 2);
    assert.match(c2[0].text, /Student: Interview me on VLSI[\s\S]*You \(tutor\): Good diagram!/);
    assert.equal(c2[1].text, "Student's new message:\nNext question, please.");
    assert.deepEqual(errors, []);
  } finally {
    await app.close();
  }
});

test('Claude Code login and install problems show how to fix them', async () => {
  const dir = tmpDir();
  writeSettings(dir, { provider: 'claudecode', claudeCodePath: fakeClaudeCommand(dir) });
  const { app, win, errors } = await launch(dir, { FAKE_CLAUDE_LOG: path.join(dir, 'calls.log') });
  try {
    await win.fill('#input', 'LOGIN_FAIL');
    await win.press('#input', 'Enter');
    await win.waitForSelector('.msg.error');
    const err = await win.textContent('.msg.error');
    assert.match(err, /Not logged in/);
    assert.match(err, /run "claude", and log in with your Claude Pro account/);

    // Settings "Check" finds the CLI, and reports a missing one clearly
    await win.click('#openSettings');
    await win.check('input[value="claudecode"]');
    await win.click('#checkClaudeCode');
    await win.waitForFunction(() => document.querySelector('#claudeCodeStatus').textContent.includes('9.9.9'));
    await win.fill('#claudeCodePath', path.join(dir, 'no-such-claude'));
    await win.click('#saveSettings');

    await win.fill('#input', 'hello');
    await win.press('#input', 'Enter');
    await win.waitForFunction(() => document.querySelectorAll('.msg.error').length === 2);
    assert.match(await win.locator('.msg.error').last().textContent(), /Couldn't find Claude Code/);
    assert.deepEqual(errors, []);
  } finally {
    await app.close();
  }
});
