// Renderer: wires the whiteboard, chat, sessions, and settings together.
const $ = (id) => document.getElementById(id);

const COLORS = ['#1f2328', '#2f6fde', '#d1342f', '#1a8a3a', '#e07b00', '#8a3ffc'];
const SIZES = [2, 3, 6, 10];

let settings = null;
let session = null; // { id, title, createdAt, updatedAt, messages: [{ role, text, image? }], board: [] }
let busy = null; // { requestId } while a reply is streaming
let saveTimer = null;

// ---------- whiteboard ----------
const board = new Whiteboard($('board'), {
  onChange: () => {
    updateAttachNote();
    scheduleSave();
  },
});

function buildToolbar() {
  document.querySelectorAll('#tools button').forEach((b) =>
    b.addEventListener('click', () => selectTool(b.dataset.tool)),
  );
  const colors = $('colors');
  COLORS.forEach((c, i) => {
    const b = document.createElement('button');
    b.title = c;
    b.innerHTML = `<span class="swatch" style="background:${c}"></span>`;
    if (i === 0) b.classList.add('active');
    b.addEventListener('click', () => {
      colors.querySelectorAll('button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      board.setColor(c);
    });
    colors.appendChild(b);
  });
  const sizes = $('sizes');
  SIZES.forEach((s) => {
    const b = document.createElement('button');
    b.title = `Size ${s}`;
    const d = Math.min(18, s + 3);
    b.innerHTML = `<span class="dot" style="width:${d}px;height:${d}px"></span>`;
    if (s === 3) b.classList.add('active');
    b.addEventListener('click', () => {
      sizes.querySelectorAll('button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      board.setSize(s);
    });
    sizes.appendChild(b);
  });
  $('undo').addEventListener('click', () => board.undo());
  $('redo').addEventListener('click', () => board.redo());
  $('clear').addEventListener('click', () => board.clear());
}

function selectTool(tool) {
  board.setTool(tool);
  document.querySelectorAll('#tools button').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
}

const KEY_TOOLS = { v: 'select', p: 'pen', e: 'eraser', l: 'line', a: 'arrow', r: 'rect', o: 'ellipse', t: 'text' };
document.addEventListener('keydown', (e) => {
  const tag = document.activeElement?.tagName;
  if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT' || document.querySelector('dialog[open]')) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    e.shiftKey ? board.redo() : board.undo();
  } else if (mod && e.key.toLowerCase() === 'y') {
    e.preventDefault();
    board.redo();
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    if (board.deleteSelected()) e.preventDefault();
  } else if (!mod && !e.altKey && KEY_TOOLS[e.key.toLowerCase()]) {
    selectTool(KEY_TOOLS[e.key.toLowerCase()]);
  }
});

function updateAttachNote() {
  const n = $('attachNote');
  if (board.isEmpty()) {
    n.textContent = 'Whiteboard is empty, so only your text will be sent.';
    n.classList.remove('on');
  } else {
    n.textContent = '🖼 A snapshot of the whiteboard will be sent with your message.';
    n.classList.add('on');
  }
}

// ---------- chat rendering ----------
function renderMarkdown(text) {
  return DOMPurify.sanitize(marked.parse(text || ''));
}

function addMessageEl(m) {
  $('emptyHint').style.display = 'none';
  const el = document.createElement('div');
  el.className = `msg ${m.role}`;
  if (m.role === 'user') {
    if (m.image) {
      const img = document.createElement('img');
      img.className = 'snap';
      img.src = `data:image/png;base64,${m.image}`;
      img.title = 'Whiteboard snapshot sent with this message';
      img.addEventListener('click', () => {
        $('viewerImg').src = img.src;
        $('viewer').showModal();
      });
      el.appendChild(img);
    }
    const t = document.createElement('div');
    if (m.text) t.textContent = m.text;
    else {
      t.className = 'muted-note';
      t.textContent = '(answer on the whiteboard)';
    }
    el.appendChild(t);
  } else if (m.role === 'assistant') {
    el.innerHTML = renderMarkdown(m.text);
  } else {
    el.textContent = m.text;
  }
  $('messages').appendChild(el);
  scrollChat();
  return el;
}

function scrollChat() {
  const box = $('messages');
  box.scrollTop = box.scrollHeight;
}

function renderChat() {
  $('messages').querySelectorAll('.msg').forEach((el) => el.remove());
  $('emptyHint').style.display = session.messages.length ? 'none' : '';
  session.messages.forEach(addMessageEl);
  $('sessionTitle').textContent = session.title;
}

$('viewer').addEventListener('click', () => $('viewer').close());

// ---------- sending ----------
// Merge consecutive same-role turns (e.g. a user message after a failed reply)
// and keep only the newest whiteboard image to save tokens and time.
function buildPayload(messages) {
  const out = [];
  for (const m of messages) {
    const prev = out.at(-1);
    if (prev && prev.role === m.role) {
      prev.text = [prev.text, m.text].filter(Boolean).join('\n\n');
      if (m.image) prev.image = m.image;
    } else out.push({ role: m.role, text: m.text, image: m.image });
  }
  out.forEach((m, i) => {
    const isLast = i === out.length - 1;
    if (m.role !== 'user') return;
    if (m.image && !isLast) {
      m.text = `${m.text || ''}\n\n[An earlier whiteboard snapshot was attached here.]`.trim();
      delete m.image;
    }
    if (isLast) {
      if (m.image) m.text = m.text || '(My answer is on the whiteboard. Please evaluate it.)';
      else m.text = `${m.text}\n\n[The whiteboard is empty.]`;
    }
    if (!m.image) delete m.image;
  });
  return out;
}

async function send() {
  if (busy) return;
  const text = $('input').value.trim();
  const image = board.exportPNG();
  if (!text && !image) return;

  if (!session.messages.length) session.title = makeTitle(text || 'Whiteboard session');
  const userMsg = { role: 'user', text, ...(image ? { image } : {}) };
  session.messages.push(userMsg);
  addMessageEl(userMsg);
  $('input').value = '';
  autoGrow();
  $('sessionTitle').textContent = session.title;
  await save();
  refreshSessionList();

  const requestId = crypto.randomUUID();
  busy = { requestId };
  setSending(true);

  const el = document.createElement('div');
  el.className = 'msg assistant typing';
  $('messages').appendChild(el);
  let acc = '';
  let pending = false;
  const off = window.api.onChunk(({ requestId: id, text: piece }) => {
    if (id !== requestId) return;
    acc += piece;
    if (!pending) {
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        el.innerHTML = renderMarkdown(acc);
        scrollChat();
      });
    }
  });
  scrollChat();

  try {
    const full = await window.api.sendChat({ requestId, messages: buildPayload(session.messages) });
    el.classList.remove('typing');
    el.innerHTML = renderMarkdown(full);
    session.messages.push({ role: 'assistant', text: full });
  } catch (err) {
    el.classList.remove('typing');
    const cancelled = /abort/i.test(String(err?.message));
    if (acc && cancelled) {
      el.innerHTML = renderMarkdown(acc + '\n\n_(stopped)_');
      session.messages.push({ role: 'assistant', text: acc });
    } else {
      el.remove();
      const msg = cancelled ? 'Stopped.' : cleanError(err);
      addMessageEl({ role: 'error', text: msg });
    }
  } finally {
    off();
    busy = null;
    setSending(false);
    await save();
    scrollChat();
  }
}

function cleanError(err) {
  // Electron prefixes IPC errors with "Error invoking remote method '…': Error: "
  return String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

function setSending(on) {
  const b = $('send');
  b.textContent = on ? 'Stop' : 'Send';
  b.classList.toggle('primary', !on);
  b.classList.toggle('stop', on);
}

$('send').addEventListener('click', () => {
  if (busy) window.api.cancelChat(busy.requestId);
  else send();
});
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send();
  }
});
function autoGrow() {
  const i = $('input');
  i.style.height = 'auto';
  i.style.height = Math.min(160, i.scrollHeight) + 'px';
}
$('input').addEventListener('input', autoGrow);

function makeTitle(t) {
  const s = t.replace(/\s+/g, ' ').trim();
  return s.length > 48 ? s.slice(0, 45) + '…' : s;
}

// ---------- sessions ----------
async function newSession() {
  if (busy) return;
  session = {
    id: await window.api.newSessionId(),
    title: 'New session',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [],
    board: [],
  };
  board.load([]);
  renderChat();
  updateAttachNote();
  refreshSessionList();
  $('input').focus();
}

async function openSession(id) {
  if (busy || id === session?.id) return;
  await save();
  session = await window.api.loadSession(id);
  board.load(session.board || []);
  renderChat();
  updateAttachNote();
  refreshSessionList();
}

// Empty sessions are not written to disk until something happens in them.
async function save() {
  clearTimeout(saveTimer);
  if (!session) return;
  session.board = board.serialize();
  if (!session.messages.length && !session.board.length) return;
  await window.api.saveSession(session);
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const wasNew = !(await window.api.listSessions()).some((s) => s.id === session.id);
    await save();
    if (wasNew) refreshSessionList();
  }, 800);
}

async function refreshSessionList() {
  const list = await window.api.listSessions();
  const ul = $('sessionList');
  ul.innerHTML = '';
  for (const s of list) {
    const li = document.createElement('li');
    li.classList.toggle('active', s.id === session?.id);
    const t = document.createElement('span');
    t.className = 'title';
    t.textContent = s.title;
    t.title = `${s.title}\n${new Date(s.updatedAt).toLocaleString()}`;
    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '×';
    del.title = 'Delete session';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete "${s.title}"?`)) return;
      await window.api.deleteSession(s.id);
      if (s.id === session?.id) await newSession();
      else refreshSessionList();
    });
    li.append(t, del);
    li.addEventListener('click', () => openSession(s.id));
    ul.appendChild(li);
  }
}

$('newSession').addEventListener('click', async () => {
  await save();
  newSession();
});
window.addEventListener('beforeunload', () => {
  if (session) {
    session.board = board.serialize();
    if (session.messages.length || session.board.length) window.api.saveSession(session);
  }
});

// ---------- settings ----------
function updateBadge() {
  $('providerBadge').textContent =
    settings.provider === 'claude'
      ? $('claudeModel').querySelector(`option[value="${settings.claudeModel}"]`)?.textContent.split(' (')[0] || settings.claudeModel
      : `Ollama · ${settings.ollamaModel || 'no model'}`;
}

function showProviderFields() {
  const p = document.querySelector('input[name="provider"]:checked')?.value;
  $('ollamaFields').style.display = p === 'ollama' ? '' : 'none';
  $('claudeFields').style.display = p === 'claude' ? '' : 'none';
}

async function loadOllamaModels() {
  const status = $('ollamaStatus');
  const sel = $('ollamaModel');
  status.className = 'hint';
  status.textContent = 'Connecting to Ollama…';
  try {
    const models = await window.api.ollamaModels($('ollamaUrl').value.trim());
    sel.innerHTML = '';
    for (const m of models) sel.add(new Option(m, m));
    if (settings.ollamaModel && models.includes(settings.ollamaModel)) sel.value = settings.ollamaModel;
    status.className = 'hint ok';
    status.textContent = models.length ? `Connected. Found ${models.length} model(s).` : 'Connected, but no models are installed.';
  } catch (err) {
    sel.innerHTML = '';
    if (settings.ollamaModel) sel.add(new Option(settings.ollamaModel, settings.ollamaModel));
    status.className = 'hint bad';
    status.textContent = `Couldn't reach Ollama: ${cleanError(err)}`;
  }
}

async function openSettings() {
  settings = await window.api.getSettings();
  document.querySelector(`input[name="provider"][value="${settings.provider}"]`).checked = true;
  $('ollamaUrl').value = settings.ollamaUrl;
  $('claudeModel').value = settings.claudeModel;
  $('claudeEffort').value = settings.claudeEffort;
  $('claudeKey').value = '';
  $('keyStatus').className = 'hint' + (settings.hasClaudeKey ? ' ok' : '');
  $('keyStatus').textContent = settings.hasClaudeKey
    ? settings.keyFromEnv
      ? 'Using ANTHROPIC_API_KEY from your environment. Paste a key here to override it.'
      : 'A key is saved (encrypted). Leave this blank to keep it, or paste a new one.'
    : 'Get a key at console.anthropic.com. It is stored encrypted on this computer.';
  showProviderFields();
  $('settings').showModal();
  loadOllamaModels();
}

document.querySelectorAll('input[name="provider"]').forEach((r) => r.addEventListener('change', showProviderFields));
$('refreshModels').addEventListener('click', loadOllamaModels);
$('openSettings').addEventListener('click', openSettings);
$('settings').addEventListener('close', async () => {
  if ($('settings').returnValue !== 'save') return;
  const patch = {
    provider: document.querySelector('input[name="provider"]:checked').value,
    ollamaUrl: $('ollamaUrl').value.trim() || 'http://localhost:11434',
    ollamaModel: $('ollamaModel').value || settings.ollamaModel,
    claudeModel: $('claudeModel').value,
    claudeEffort: $('claudeEffort').value,
  };
  const key = $('claudeKey').value.trim();
  if (key) patch.claudeKey = key;
  await window.api.setSettings(patch);
  settings = await window.api.getSettings();
  updateBadge();
});

// ---------- boot ----------
(async function init() {
  marked.setOptions({ breaks: true });
  buildToolbar();
  selectTool('pen');
  settings = await window.api.getSettings();
  updateBadge();
  const list = await window.api.listSessions();
  if (list.length) await openSession(list[0].id);
  else await newSession();
  const firstRun = settings.provider === 'ollama' ? !settings.ollamaModel : !settings.hasClaudeKey;
  if (firstRun) openSettings();
})();
