'use strict';
/*
 * bridge-selftest.js — black-box test of bridge.js routing (no browser).
 * Spins up a fake EDITOR + a fake CONTROLLER, then checks:
 *   1. listEditors (bridge-handled) sees the editor
 *   2. a command from controller reaches the editor
 *   3. the editor's result routes back to the controller (matched by reqId)
 *   4. an event from the editor broadcasts to the controller
 * Exit 0 = pass, 1 = fail. Assumes bridge already running on PORT.
 */
const WebSocket = require('ws');
const PORT = process.env.PORT || 8077;
const URL = `ws://127.0.0.1:${PORT}`;

const checks = [];
const ok = (name, cond) => { checks.push({ name, pass: !!cond }); console.log(`${cond ? '✓' : '✗'} ${name}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const send = (ws, o) => ws.send(JSON.stringify(o));

(async () => {
  // fake editor: replies to commands, can emit events
  const editor = new WebSocket(URL);
  let editorGotCommand = null;
  await new Promise(res => editor.on('open', res));
  editor.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.type === 'command') {
      editorGotCommand = m;
      send(editor, { type: 'result', reqId: m.reqId, ok: true, data: { echoed: m.verb, args: m.args } });
    }
  });
  send(editor, { type: 'register', role: 'editor', name: 'fake-editor' });
  await sleep(150);

  // controller
  const ctrl = new WebSocket(URL);
  const results = {};           // reqId -> result msg
  const events = [];
  await new Promise(res => ctrl.on('open', res));
  ctrl.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.type === 'result') results[m.reqId] = m;
    if (m.type === 'event') events.push(m);
  });
  send(ctrl, { type: 'register', role: 'controller', name: 'tester' });
  await sleep(150);

  // 1. listEditors
  send(ctrl, { type: 'command', reqId: 'r1', verb: 'listEditors' });
  await sleep(150);
  ok('listEditors returns the editor', results.r1 && results.r1.ok && results.r1.data.some(e => e.name === 'fake-editor'));

  // 2 + 3. command reaches editor, result routes back
  send(ctrl, { type: 'command', reqId: 'r2', verb: 'getProject', args: { foo: 1 } });
  await sleep(200);
  ok('command reached the editor', editorGotCommand && editorGotCommand.verb === 'getProject');
  ok('editor result routed back to controller', results.r2 && results.r2.ok && results.r2.data.echoed === 'getProject');
  ok('command args passed through', editorGotCommand && editorGotCommand.args.foo === 1);

  // 4. event broadcast
  send(editor, { type: 'event', name: 'DidSelectClip', data: { clip: 'x' } });
  await sleep(150);
  ok('event broadcast to controller', events.some(e => e.name === 'DidSelectClip' && e.data.clip === 'x'));

  // ping
  send(ctrl, { type: 'command', reqId: 'r3', verb: 'ping' });
  await sleep(100);
  ok('ping → pong', results.r3 && results.r3.data === 'pong');

  editor.close(); ctrl.close();
  const failed = checks.filter(c => !c.pass).length;
  console.log(`\n${checks.length - failed}/${checks.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('selftest error:', e); process.exit(1); });
