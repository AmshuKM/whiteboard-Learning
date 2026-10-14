// Vector whiteboard on a <canvas>. Every mark is an object, so we can undo,
// move, erase whole strokes, save to JSON, and export a clean PNG for the AI.
//
// Object shapes:
//   { type: 'pen', color, size, points: [[x, y], ...] }
//   { type: 'line' | 'arrow' | 'rect' | 'ellipse', color, size, x1, y1, x2, y2 }
//   { type: 'text', color, size, x, y, text }   (size = font px)

const FONT = '"Segoe UI", system-ui, -apple-system, sans-serif';
const MAX_EXPORT = 1568; // long edge; larger images are downscaled by vision models anyway

class Whiteboard {
  constructor(container, { onChange } = {}) {
    this.container = container;
    this.onChange = onChange || (() => {});
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d');
    container.appendChild(this.canvas);

    this.objects = [];
    this.undoStack = [];
    this.redoStack = [];
    this.tool = 'pen';
    this.color = '#1f2328';
    this.size = 3;
    this.selected = null;
    this.drawing = null; // object being created
    this.dragging = null; // { obj, lastX, lastY }
    this.erasing = false;
    this.textEditor = null;

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.bindEvents();
  }

  // ---------- public API ----------
  setTool(tool) {
    this.commitText();
    this.tool = tool;
    this.selected = null;
    this.canvas.dataset.tool = tool;
    this.render();
  }
  setColor(c) {
    this.color = c;
    if (this.selected) this.mutate(() => (this.selected.color = c));
  }
  setSize(s) {
    this.size = s;
  }
  undo() {
    this.commitText();
    if (!this.undoStack.length) return;
    this.redoStack.push(JSON.stringify(this.objects));
    this.objects = JSON.parse(this.undoStack.pop());
    this.selected = null;
    this.changed();
  }
  redo() {
    if (!this.redoStack.length) return;
    this.undoStack.push(JSON.stringify(this.objects));
    this.objects = JSON.parse(this.redoStack.pop());
    this.selected = null;
    this.changed();
  }
  clear() {
    this.commitText();
    if (!this.objects.length) return;
    this.mutate(() => (this.objects = []));
    this.selected = null;
  }
  isEmpty() {
    return this.objects.length === 0;
  }
  serialize() {
    return JSON.parse(JSON.stringify(this.objects));
  }
  load(objects) {
    this.commitText();
    this.objects = Array.isArray(objects) ? objects : [];
    this.undoStack = [];
    this.redoStack = [];
    this.selected = null;
    this.render();
  }

  // Returns base64 PNG (no data: prefix) cropped to the drawing, or null if empty.
  exportPNG() {
    this.commitText();
    if (!this.objects.length) return null;
    const b = this.bounds();
    const pad = 32;
    const w = b.maxX - b.minX + pad * 2;
    const h = b.maxY - b.minY + pad * 2;
    // Upscale small drawings a bit (helps vision models read labels), cap large ones.
    const scale = Math.min(2, MAX_EXPORT / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.round(w * scale);
    c.height = Math.round(h * scale);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.scale(scale, scale);
    ctx.translate(pad - b.minX, pad - b.minY);
    for (const o of this.objects) this.drawObject(ctx, o);
    return c.toDataURL('image/png').split(',')[1];
  }

  // ---------- internals ----------
  mutate(fn) {
    this.undoStack.push(JSON.stringify(this.objects));
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
    fn();
    this.changed();
  }
  changed() {
    this.render();
    this.onChange();
  }

  resize() {
    const r = this.container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.round(r.width * dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * dpr));
    this.canvas.style.width = r.width + 'px';
    this.canvas.style.height = r.height + 'px';
    this.render();
  }

  pos(e) {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  bindEvents() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => this.onDown(e));
    c.addEventListener('pointermove', (e) => this.onMove(e));
    c.addEventListener('pointerup', (e) => this.onUp(e));
    c.addEventListener('pointercancel', (e) => this.onUp(e));
    c.addEventListener('dblclick', (e) => {
      const [x, y] = this.pos(e);
      const hit = this.hitTest(x, y);
      if (hit && hit.type === 'text') this.editText(hit);
    });
  }

  onDown(e) {
    if (e.button !== 0) return;
    const [x, y] = this.pos(e);
    // Take focus away from the chat box so tool shortcuts reach the board.
    if (!this.textEditor && document.activeElement && document.activeElement !== document.body) {
      document.activeElement.blur();
    }
    if (this.textEditor) {
      this.commitText();
      if (this.tool === 'text') return; // first click just closes the editor
    }
    this.canvas.setPointerCapture(e.pointerId);
    const base = { color: this.color, size: this.size };

    switch (this.tool) {
      case 'pen':
        this.drawing = { type: 'pen', ...base, points: [[x, y]] };
        break;
      case 'line':
      case 'arrow':
      case 'rect':
      case 'ellipse':
        this.drawing = { type: this.tool, ...base, x1: x, y1: y, x2: x, y2: y };
        break;
      case 'text': {
        const hit = this.hitTest(x, y);
        if (hit && hit.type === 'text') this.editText(hit);
        else this.editText(null, x, y);
        break;
      }
      case 'eraser':
        this.erasing = true;
        this.undoStack.push(JSON.stringify(this.objects));
        this.redoStack = [];
        this.eraseAt(x, y);
        break;
      case 'select': {
        const hit = this.hitTest(x, y);
        this.selected = hit;
        if (hit) {
          this.undoStack.push(JSON.stringify(this.objects));
          this.redoStack = [];
          this.dragging = { obj: hit, lastX: x, lastY: y, moved: false };
        }
        this.render();
        break;
      }
    }
  }

  onMove(e) {
    const [x, y] = this.pos(e);
    if (this.drawing) {
      if (this.drawing.type === 'pen') this.drawing.points.push([x, y]);
      else {
        this.drawing.x2 = x;
        this.drawing.y2 = y;
        if (e.shiftKey) this.constrain(this.drawing);
      }
      this.render();
    } else if (this.erasing) {
      this.eraseAt(x, y);
    } else if (this.dragging) {
      const d = this.dragging;
      translate(d.obj, x - d.lastX, y - d.lastY);
      d.lastX = x;
      d.lastY = y;
      d.moved = true;
      this.render();
    } else if (this.tool === 'select') {
      this.canvas.style.cursor = this.hitTest(x, y) ? 'move' : 'default';
    }
  }

  onUp() {
    if (this.drawing) {
      const o = this.drawing;
      this.drawing = null;
      const tiny = o.type === 'pen' ? false : Math.hypot(o.x2 - o.x1, o.y2 - o.y1) < 3;
      if (!tiny) this.mutate(() => this.objects.push(o));
      else this.render();
    }
    if (this.erasing) {
      this.erasing = false;
      // Drop the snapshot if nothing was actually erased.
      if (this.undoStack.at(-1) === JSON.stringify(this.objects)) this.undoStack.pop();
      else this.onChange();
    }
    if (this.dragging) {
      if (!this.dragging.moved) this.undoStack.pop();
      else this.onChange();
      this.dragging = null;
    }
  }

  deleteSelected() {
    if (!this.selected) return false;
    const s = this.selected;
    this.mutate(() => (this.objects = this.objects.filter((o) => o !== s)));
    this.selected = null;
    this.render();
    return true;
  }

  constrain(o) {
    const dx = o.x2 - o.x1;
    const dy = o.y2 - o.y1;
    if (o.type === 'rect' || o.type === 'ellipse') {
      const m = Math.max(Math.abs(dx), Math.abs(dy));
      o.x2 = o.x1 + Math.sign(dx || 1) * m;
      o.y2 = o.y1 + Math.sign(dy || 1) * m;
    } else {
      // snap lines to 45° steps
      const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
      const len = Math.hypot(dx, dy);
      o.x2 = o.x1 + Math.cos(ang) * len;
      o.y2 = o.y1 + Math.sin(ang) * len;
    }
  }

  eraseAt(x, y) {
    const r = Math.max(8, this.size * 2);
    const before = this.objects.length;
    this.objects = this.objects.filter((o) => !hits(this.ctx, o, x, y, r));
    if (this.objects.length !== before) this.render();
  }

  hitTest(x, y) {
    for (let i = this.objects.length - 1; i >= 0; i--) {
      if (hits(this.ctx, this.objects[i], x, y, 8)) return this.objects[i];
    }
    return null;
  }

  // ----- text editing via an overlaid textarea -----
  editText(obj, x, y) {
    const ta = document.createElement('textarea');
    ta.className = 'wb-text-editor';
    const fontSize = obj ? obj.size : textSize(this.size);
    ta.style.font = `${fontSize}px ${FONT}`;
    ta.style.color = obj ? obj.color : this.color;
    ta.style.left = (obj ? obj.x : x) + 'px';
    ta.style.top = (obj ? obj.y : y) + 'px';
    ta.value = obj ? obj.text : '';
    ta.rows = 1;
    const autosize = () => {
      ta.style.height = 'auto';
      ta.style.height = ta.scrollHeight + 'px';
      ta.style.width = 'auto';
      ta.style.width = Math.max(60, ta.scrollWidth + 4) + 'px';
    };
    ta.addEventListener('input', autosize);
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        this.commitText();
      }
    });
    ta.addEventListener('blur', () => this.commitText());
    this.container.appendChild(ta);
    this.textEditor = { ta, obj, x, y, fontSize };
    if (obj) {
      obj._hidden = true;
      this.render();
    }
    autosize();
    setTimeout(() => ta.focus(), 0);
  }

  commitText() {
    const ed = this.textEditor;
    if (!ed) return;
    this.textEditor = null;
    const text = ed.ta.value.replace(/\s+$/, '');
    ed.ta.remove();
    if (ed.obj) {
      delete ed.obj._hidden;
      if (text === ed.obj.text) return this.render();
      if (!text) this.mutate(() => (this.objects = this.objects.filter((o) => o !== ed.obj)));
      else this.mutate(() => (ed.obj.text = text));
    } else if (text) {
      this.mutate(() =>
        this.objects.push({ type: 'text', color: this.color, size: ed.fontSize, x: ed.x, y: ed.y, text }),
      );
    }
  }

  bounds() {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const o of this.objects) {
      const b = objBounds(this.ctx, o);
      minX = Math.min(minX, b.minX);
      minY = Math.min(minY, b.minY);
      maxX = Math.max(maxX, b.maxX);
      maxY = Math.max(maxY, b.maxY);
    }
    return { minX, minY, maxX, maxY };
  }

  render() {
    const ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (const o of this.objects) if (!o._hidden) this.drawObject(ctx, o);
    if (this.drawing) this.drawObject(ctx, this.drawing);
    if (this.selected && this.objects.includes(this.selected)) {
      const b = objBounds(ctx, this.selected);
      ctx.save();
      ctx.strokeStyle = '#2f81f7';
      ctx.lineWidth = 1;
      ctx.setLineDash([5, 4]);
      ctx.strokeRect(b.minX - 6, b.minY - 6, b.maxX - b.minX + 12, b.maxY - b.minY + 12);
      ctx.restore();
    }
  }

  drawObject(ctx, o) {
    ctx.save();
    ctx.strokeStyle = o.color;
    ctx.fillStyle = o.color;
    ctx.lineWidth = o.size;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    switch (o.type) {
      case 'pen': {
        const p = o.points;
        ctx.beginPath();
        if (p.length === 1) {
          ctx.arc(p[0][0], p[0][1], o.size / 2, 0, Math.PI * 2);
          ctx.fill();
          break;
        }
        ctx.moveTo(p[0][0], p[0][1]);
        // smooth with quadratic curves through midpoints
        for (let i = 1; i < p.length - 1; i++) {
          const mx = (p[i][0] + p[i + 1][0]) / 2;
          const my = (p[i][1] + p[i + 1][1]) / 2;
          ctx.quadraticCurveTo(p[i][0], p[i][1], mx, my);
        }
        ctx.lineTo(p.at(-1)[0], p.at(-1)[1]);
        ctx.stroke();
        break;
      }
      case 'line':
      case 'arrow':
        ctx.beginPath();
        ctx.moveTo(o.x1, o.y1);
        ctx.lineTo(o.x2, o.y2);
        ctx.stroke();
        if (o.type === 'arrow') {
          const ang = Math.atan2(o.y2 - o.y1, o.x2 - o.x1);
          const head = 10 + o.size * 2;
          ctx.beginPath();
          ctx.moveTo(o.x2, o.y2);
          ctx.lineTo(o.x2 - head * Math.cos(ang - 0.45), o.y2 - head * Math.sin(ang - 0.45));
          ctx.moveTo(o.x2, o.y2);
          ctx.lineTo(o.x2 - head * Math.cos(ang + 0.45), o.y2 - head * Math.sin(ang + 0.45));
          ctx.stroke();
        }
        break;
      case 'rect':
        ctx.strokeRect(Math.min(o.x1, o.x2), Math.min(o.y1, o.y2), Math.abs(o.x2 - o.x1), Math.abs(o.y2 - o.y1));
        break;
      case 'ellipse':
        ctx.beginPath();
        ctx.ellipse(
          (o.x1 + o.x2) / 2, (o.y1 + o.y2) / 2,
          Math.abs(o.x2 - o.x1) / 2, Math.abs(o.y2 - o.y1) / 2,
          0, 0, Math.PI * 2,
        );
        ctx.stroke();
        break;
      case 'text': {
        ctx.font = `${o.size}px ${FONT}`;
        ctx.textBaseline = 'top';
        const lh = o.size * 1.25;
        o.text.split('\n').forEach((line, i) => ctx.fillText(line, o.x + 2, o.y + 2 + i * lh));
        break;
      }
    }
    ctx.restore();
  }
}

// ---------- geometry helpers ----------
function textSize(strokeSize) {
  return { 2: 16, 3: 20, 6: 26, 10: 34 }[strokeSize] || 20;
}

function translate(o, dx, dy) {
  if (o.type === 'pen') o.points = o.points.map(([x, y]) => [x + dx, y + dy]);
  else if (o.type === 'text') {
    o.x += dx;
    o.y += dy;
  } else {
    o.x1 += dx; o.x2 += dx;
    o.y1 += dy; o.y2 += dy;
  }
}

function textMetrics(ctx, o) {
  ctx.save();
  ctx.font = `${o.size}px ${FONT}`;
  const lines = o.text.split('\n');
  const w = Math.max(...lines.map((l) => ctx.measureText(l).width));
  ctx.restore();
  return { w: w + 4, h: lines.length * o.size * 1.25 + 4 };
}

function objBounds(ctx, o) {
  const pad = (o.size || 0) / 2;
  if (o.type === 'pen') {
    const xs = o.points.map((p) => p[0]);
    const ys = o.points.map((p) => p[1]);
    return { minX: Math.min(...xs) - pad, minY: Math.min(...ys) - pad, maxX: Math.max(...xs) + pad, maxY: Math.max(...ys) + pad };
  }
  if (o.type === 'text') {
    const m = textMetrics(ctx, o);
    return { minX: o.x, minY: o.y, maxX: o.x + m.w, maxY: o.y + m.h };
  }
  const extra = o.type === 'arrow' ? 10 + o.size * 2 : pad;
  return {
    minX: Math.min(o.x1, o.x2) - extra, minY: Math.min(o.y1, o.y2) - extra,
    maxX: Math.max(o.x1, o.x2) + extra, maxY: Math.max(o.y1, o.y2) + extra,
  };
}

function distToSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function hits(ctx, o, x, y, r) {
  const tol = r + (o.size || 0) / 2;
  switch (o.type) {
    case 'pen': {
      const p = o.points;
      if (p.length === 1) return Math.hypot(x - p[0][0], y - p[0][1]) <= tol;
      for (let i = 1; i < p.length; i++) if (distToSeg(x, y, p[i - 1][0], p[i - 1][1], p[i][0], p[i][1]) <= tol) return true;
      return false;
    }
    case 'line':
    case 'arrow':
      return distToSeg(x, y, o.x1, o.y1, o.x2, o.y2) <= tol;
    case 'rect': {
      const [a, b, c, d] = [Math.min(o.x1, o.x2), Math.min(o.y1, o.y2), Math.max(o.x1, o.x2), Math.max(o.y1, o.y2)];
      return (
        distToSeg(x, y, a, b, c, b) <= tol || distToSeg(x, y, c, b, c, d) <= tol ||
        distToSeg(x, y, c, d, a, d) <= tol || distToSeg(x, y, a, d, a, b) <= tol
      );
    }
    case 'ellipse': {
      const cx = (o.x1 + o.x2) / 2, cy = (o.y1 + o.y2) / 2;
      const rx = Math.abs(o.x2 - o.x1) / 2, ry = Math.abs(o.y2 - o.y1) / 2;
      if (rx < 1 || ry < 1) return distToSeg(x, y, o.x1, o.y1, o.x2, o.y2) <= tol;
      // approximate distance to the outline using normalized radius
      const k = Math.hypot((x - cx) / rx, (y - cy) / ry);
      return Math.abs(k - 1) * Math.min(rx, ry) <= tol;
    }
    case 'text': {
      const m = textMetrics(ctx, o);
      return x >= o.x - r && x <= o.x + m.w + r && y >= o.y - r && y <= o.y + m.h + r;
    }
  }
  return false;
}

window.Whiteboard = Whiteboard;
