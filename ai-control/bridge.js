'use strict';
/*
 * bridge.js — the rendezvous WebSocket server for AI control of AudioMass.
 *
 * Fixed port. Two kinds of clients connect here; neither finds the other —
 * they both find the bridge:
 *   - EDITORS    : the AudioMass page (control.js dials in, registers, executes commands)
 *   - CONTROLLERS: an AI client (sends commands, receives results + events)
 *
 * Message protocol (one JSON object per WS message):
 *   client→bridge  {type:"register", role:"editor"|"controller", name?}
 *   bridge→client  {type:"registered", id, role}
 *   controller→    {type:"command", reqId, verb, args?, target?}        target: editorId | "active" (default)
 *   →controller    {type:"result", reqId, ok:true, data} | {type:"result", reqId, ok:false, error}
 *   editor→        {type:"result", reqId, ok, data|error}   (reply to a command)
 *   editor→        {type:"event", name, data}               (Did* notification → broadcast to controllers)
 *   bridge handles {verb:"listEditors"} and {verb:"ping"} directly.
 *
 * No auth (localhost only). Run: node bridge.js  [--port 8077]
 */
const { WebSocketServer } = require('ws');

const PORT = (() => {
  const i = process.argv.indexOf('--port');
  return i > -1 ? parseInt(process.argv[i + 1], 10) : 8077;
})();

let nextId = 1;
const editors = new Map();      // id -> {ws, name, lastSeen}
const controllers = new Map();  // id -> {ws, name}
const pending = new Map();      // reqId -> controllerId (so results route back)

const now = () => new Date().toISOString().slice(11, 19);
const log = (...a) => console.log(`[bridge ${now()}]`, ...a);
const send = (ws, obj) => { try { ws.send(JSON.stringify(obj)); } catch (_) {} };

function activeEditorId(preferred) {
  if (preferred && preferred !== 'active' && editors.has(preferred)) return preferred;
  // default: the most-recently-registered editor
  let last = null;
  for (const id of editors.keys()) last = id;
  return last;
}

function editorList() {
  return [...editors.entries()].map(([id, e]) => ({ id, name: e.name }));
}

const wss = new WebSocketServer({ port: PORT, host: '127.0.0.1' });

wss.on('listening', () => log(`listening on ws://127.0.0.1:${PORT}`));
wss.on('error', (e) => log('SERVER ERROR', e.message));

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); }
    catch { return send(ws, { type: 'error', error: 'invalid JSON' }); }

    // --- registration ---
    if (msg.type === 'register') {
      const id = `${msg.role || 'client'}-${nextId++}`;
      ws._id = id; ws._role = msg.role;
      if (msg.role === 'editor') {
        editors.set(id, { ws, name: msg.name || id, lastSeen: Date.now() });
        log(`editor connected: ${id} (${msg.name || ''}) — ${editors.size} editor(s)`);
        // tell controllers an editor appeared
        for (const c of controllers.values()) send(c.ws, { type: 'event', name: 'EditorConnected', data: { id, name: msg.name } });
      } else {
        controllers.set(id, { ws, name: msg.name || id });
        log(`controller connected: ${id} — ${controllers.size} controller(s)`);
      }
      return send(ws, { type: 'registered', id, role: msg.role });
    }

    // --- a controller issuing a command ---
    if (msg.type === 'command') {
      // bridge-handled verbs
      if (msg.verb === 'ping') return send(ws, { type: 'result', reqId: msg.reqId, ok: true, data: 'pong' });
      if (msg.verb === 'listEditors') return send(ws, { type: 'result', reqId: msg.reqId, ok: true, data: editorList() });

      const targetId = activeEditorId(msg.target);
      if (!targetId) return send(ws, { type: 'result', reqId: msg.reqId, ok: false, error: 'no editor connected' });
      pending.set(msg.reqId, ws._id);
      const ed = editors.get(targetId);
      send(ed.ws, { type: 'command', reqId: msg.reqId, verb: msg.verb, args: msg.args || {} });
      return;
    }

    // --- an editor returning a result → route to the controller that asked ---
    if (msg.type === 'result') {
      const cid = pending.get(msg.reqId);
      pending.delete(msg.reqId);
      const c = cid && controllers.get(cid);
      if (c) send(c.ws, msg);
      return;
    }

    // --- an editor emitting a Did* event → broadcast to all controllers ---
    if (msg.type === 'event') {
      for (const c of controllers.values()) send(c.ws, msg);
      return;
    }
  });

  ws.on('close', () => {
    if (ws._role === 'editor' && editors.has(ws._id)) {
      editors.delete(ws._id);
      log(`editor disconnected: ${ws._id} — ${editors.size} left`);
      for (const c of controllers.values()) send(c.ws, { type: 'event', name: 'EditorDisconnected', data: { id: ws._id } });
    } else if (ws._role === 'controller' && controllers.has(ws._id)) {
      controllers.delete(ws._id);
      log(`controller disconnected: ${ws._id} — ${controllers.size} left`);
    }
  });
});

// heartbeat: drop dead sockets every 30s
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch (_) {}
  }
}, 30000);

log(`AudioMass AI-control bridge starting on port ${PORT}`);
