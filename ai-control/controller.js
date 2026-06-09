'use strict';
/*
 * controller.js — the "controller" client for the AudioMass AI-control bridge.
 *
 * Two faces in one file:
 *
 *   1. A small library (`class Controller`) you can `require()` from other Node code
 *      or from a skill. It speaks the bridge's WebSocket protocol (see bridge.js):
 *        → {type:"register", role:"controller", name}
 *        → {type:"command", reqId, verb, args, target}
 *        ← {type:"result", reqId, ok, data|error}
 *        ← {type:"event", name, data}            (Did* notifications, broadcast)
 *      `send(verb, args, target)` auto-generates a reqId, returns a Promise that
 *      resolves with the matching result and rejects on ok:false or a ~10s timeout.
 *      `on(eventName, cb)` subscribes to broadcast events ('*' for all).
 *
 *   2. A CLI so a shell — or an AI driving a shell — can issue single commands:
 *        node controller.js listEditors
 *        node controller.js getProject
 *        node controller.js seekTo '{"time":3}'
 *        node controller.js fadeOut '{"secs":2}'
 *        node controller.js --watch          (stream all incoming events)
 *        node controller.js --help
 *      Results print as pretty JSON. Exit 0 on ok:true, 1 on ok:false/timeout/error.
 *
 * The controller is intentionally verb-agnostic: it does not hard-code the editor's
 * verb list. Whatever verb you pass is forwarded to the editor (or handled by the
 * bridge for `ping`/`listEditors`). Use `listVerbs` to ask the editor what it supports.
 *
 * No auth (localhost only). Default endpoint: ws://127.0.0.1:8077.
 */

const WebSocket = require('ws');

const DEFAULT_URL = 'ws://127.0.0.1:8077';
const DEFAULT_TIMEOUT_MS = 15000;

// Some verbs legitimately take much longer than a snappy command: they fetch +
// decode audio, run a worker-based encode, or chain several of those. The editor
// side already budgets real time for them (e.g. export waits up to 60s for the
// encode), so the CLI's per-command timeout must be at least as generous or the
// controller gives up while the editor is still working — exactly the failure a
// cold operator hit on `export`. These are the defaults applied automatically
// when the caller does NOT pass an explicit --timeout. (Generous on purpose:
// a too-long wait only matters when something is genuinely broken, whereas a
// too-short one breaks correct, in-progress work.)
const VERB_TIMEOUTS = {
  export:            75000,
  loadAudio:         45000,
  addClip:           45000,
  measureLUFS:       30000,
  autoLevel:         75000,
  duckMusicUnderVoice: 30000,
  trimDeadAir:       45000,
  applyStandardFades: 45000,
  compareVersions:   45000,
  addVersionAsTrack: 90000,
  swapVersion:       90000,
  assembleSegments:  240000,
  layInShow:         240000,
  polishShow:        120000,
  batch:             300000
};

/** The timeout to use for a verb when the caller didn't pass an explicit --timeout. */
function timeoutForVerb(verb) {
  return (verb && VERB_TIMEOUTS[verb]) || DEFAULT_TIMEOUT_MS;
}

/**
 * A controller-role client for the bridge.
 *
 * Lifecycle: `new Controller()` → `await connect()` → `await send(...)` → `close()`.
 * Safe to fire many `send()` calls concurrently; each is matched back by reqId.
 */
class Controller {
  /**
   * @param {object} [opts]
   * @param {string} [opts.url]        bridge WebSocket URL
   * @param {string} [opts.name]       controller name reported to the bridge
   * @param {number} [opts.timeout]    per-command timeout in ms
   */
  constructor(opts = {}) {
    this.url = opts.url || DEFAULT_URL;
    this.name = opts.name || 'cli';
    this.timeout = opts.timeout || DEFAULT_TIMEOUT_MS;

    this.ws = null;
    this.id = null;                 // our controller id, assigned by the bridge
    this._seq = 0;                  // reqId counter
    this._pending = new Map();      // reqId -> {resolve, reject, timer}
    this._listeners = new Map();    // eventName ('*' allowed) -> Set<cb>
    this._closed = false;
  }

  /**
   * Open the WebSocket and register as a controller.
   * @returns {Promise<{id:string, role:string}>} resolves once the bridge confirms registration.
   * Rejects with a clear message if the bridge is not reachable.
   */
  connect() {
    return new Promise((resolve, reject) => {
      let settled = false;
      let registered = false;

      try {
        this.ws = new WebSocket(this.url);
      } catch (err) {
        return reject(new Error(`Could not create WebSocket for ${this.url}: ${err.message}`));
      }

      // Connection-time errors (e.g. bridge not running → ECONNREFUSED).
      this.ws.on('error', (err) => {
        if (!settled) {
          settled = true;
          reject(new Error(friendlyConnError(err, this.url)));
        }
        // After connect, errors surface via 'close'; we don't crash here.
      });

      this.ws.on('open', () => {
        // Register, then wait for the bridge's {type:"registered"} confirmation.
        this._raw({ type: 'register', role: 'controller', name: this.name });
      });

      this.ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }

        if (msg.type === 'registered' && !registered) {
          registered = true;
          this.id = msg.id;
          if (!settled) { settled = true; resolve({ id: msg.id, role: msg.role }); }
          return;
        }
        this._handleMessage(msg);
      });

      this.ws.on('close', () => {
        // Fail any in-flight commands so callers aren't left hanging.
        const err = new Error('connection to bridge closed');
        for (const [, p] of this._pending) { clearTimeout(p.timer); p.reject(err); }
        this._pending.clear();
        if (!settled) { settled = true; reject(new Error(`Connection to bridge at ${this.url} closed before registration.`)); }
        this._emit('Disconnected', {});
      });
    });
  }

  /** Route an incoming (non-registration) message to pending commands / event listeners. */
  _handleMessage(msg) {
    if (msg.type === 'result') {
      const p = this._pending.get(msg.reqId);
      if (!p) return;                       // unknown/late reqId — ignore
      this._pending.delete(msg.reqId);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg);
      else p.reject(makeResultError(msg));
      return;
    }
    if (msg.type === 'event') {
      this._emit(msg.name, msg.data, msg);
      return;
    }
    if (msg.type === 'error') {
      // Bridge-level protocol error not tied to a reqId; surface to '*' listeners.
      this._emit('Error', { error: msg.error }, msg);
    }
  }

  /** Low-level send of a raw protocol object. Throws if not connected. */
  _raw(obj) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('not connected to bridge (call connect() first)');
    }
    this.ws.send(JSON.stringify(obj));
  }

  /**
   * Issue a command and await its result.
   * @param {string} verb            e.g. 'getProject', 'seekTo', 'listEditors'
   * @param {object} [args]          verb arguments
   * @param {string} [target]        editor id, or 'active' (default) for the most-recent editor
   * @returns {Promise<object>}      resolves with the full result message {type,reqId,ok:true,data}
   *                                 rejects with an Error (carrying .result) on ok:false/timeout/disconnect
   */
  send(verb, args = {}, target = 'active') {
    return new Promise((resolve, reject) => {
      if (!verb || typeof verb !== 'string') {
        return reject(new Error('send(verb): verb must be a non-empty string'));
      }
      const reqId = `c${this.id || 'x'}-${++this._seq}-${Date.now().toString(36)}`;

      const timer = setTimeout(() => {
        this._pending.delete(reqId);
        const e = new Error(`command "${verb}" timed out after ${this.timeout}ms`);
        e.timeout = true;
        reject(e);
      }, this.timeout);
      if (typeof timer.unref === 'function') timer.unref();

      this._pending.set(reqId, { resolve, reject, timer });

      try {
        this._raw({ type: 'command', reqId, verb, args: args || {}, target });
      } catch (err) {
        this._pending.delete(reqId);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  /**
   * Subscribe to broadcast events. Use the event name (e.g. 'DidSelectClip') or
   * '*' to receive every event. Returns an unsubscribe function.
   * @param {string} eventName
   * @param {(data:any, fullMsg:object)=>void} cb
   * @returns {() => void} unsubscribe
   */
  on(eventName, cb) {
    if (!this._listeners.has(eventName)) this._listeners.set(eventName, new Set());
    this._listeners.get(eventName).add(cb);
    return () => this.off(eventName, cb);
  }

  /** Remove a previously-registered event listener. */
  off(eventName, cb) {
    const set = this._listeners.get(eventName);
    if (set) set.delete(cb);
  }

  /** Dispatch an event to its listeners and to '*' listeners. */
  _emit(name, data, fullMsg) {
    const fire = (set) => { if (set) for (const cb of set) { try { cb(data, fullMsg || { name, data }); } catch (_) {} } };
    fire(this._listeners.get(name));
    fire(this._listeners.get('*'));
  }

  /** Close the connection. Idempotent. */
  close() {
    this._closed = true;
    if (this.ws) { try { this.ws.close(); } catch (_) {} }
  }
}

/** Build an Error from an ok:false result, attaching the raw result for callers. */
function makeResultError(msg) {
  const detail = typeof msg.error === 'string' ? msg.error : JSON.stringify(msg.error);
  const e = new Error(detail || 'command failed');
  e.result = msg;
  return e;
}

/** Turn a raw socket error into an actionable message (the common case: bridge down). */
function friendlyConnError(err, url) {
  const code = err && err.code;
  if (code === 'ECONNREFUSED') {
    return `Cannot reach the bridge at ${url} (connection refused).\n` +
           `Is it running? Start it with:  node bridge.js   (or: npm run bridge)`;
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return `Cannot resolve the bridge host in ${url}: ${err.message}`;
  }
  return `WebSocket error connecting to ${url}: ${(err && err.message) || err}`;
}

module.exports = { Controller, DEFAULT_URL, DEFAULT_TIMEOUT_MS, VERB_TIMEOUTS, timeoutForVerb };

/* ---------------------------------------------------------------------------
 * CLI
 * ------------------------------------------------------------------------- */

const HELP = `audiomass controller — drive the AI-control bridge from a shell.

USAGE
  node controller.js <verb> [jsonArgs]     run one command, print the result, exit
  node controller.js --watch               connect and stream all incoming events
  node controller.js --help                show this help

OPTIONS
  --url <ws-url>     bridge endpoint           (default: ${DEFAULT_URL})
  --target <id>      editor to target, or "active" for the most-recent (default: active)
  --timeout <ms>     per-command timeout       (default: ${DEFAULT_TIMEOUT_MS})
  --raw              print the full result envelope, not just .data

EXAMPLES
  node controller.js listEditors
  node controller.js listVerbs
  node controller.js getProject
  node controller.js getSelection
  node controller.js play
  node controller.js seekTo '{"time":3}'
  node controller.js select '{"start":1,"end":4}'
  node controller.js fadeOut '{"secs":2}'
  node controller.js gain '{"db":-3}'
  node controller.js normalizeLUFS '{"target":-16}'
  node controller.js --target editor-2 getProject
  node controller.js --watch

NOTES
  jsonArgs is a single JSON object (quote it for your shell). Omit for no args.
  Exit code: 0 when ok:true, 1 on ok:false, timeout, bad input, or no bridge.
  "ping" and "listEditors" are answered by the bridge itself; every other verb
  is forwarded to the editor, so the available verbs are whatever the editor
  implements — ask it with:  node controller.js listVerbs`;

/** Minimal flag parser: pulls known --flags out, leaves positionals in order. */
function parseArgv(argv) {
  const out = { url: DEFAULT_URL, target: 'active', timeout: DEFAULT_TIMEOUT_MS, timeoutExplicit: false, raw: false, watch: false, help: false, _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--help': case '-h': out.help = true; break;
      case '--watch': out.watch = true; break;
      case '--raw': out.raw = true; break;
      case '--url': out.url = argv[++i]; break;
      case '--target': out.target = argv[++i]; break;
      case '--timeout': out.timeout = parseInt(argv[++i], 10); out.timeoutExplicit = true; break;
      default:
        if (a && a.startsWith('--')) { out._unknown = a; }
        else out._.push(a);
    }
  }
  return out;
}

function pretty(v) { return JSON.stringify(v, null, 2); }

async function cliMain() {
  const opts = parseArgv(process.argv.slice(2));

  if (opts.help || (!opts.watch && opts._.length === 0)) {
    console.log(HELP);
    process.exit(opts.help ? 0 : (opts._.length === 0 && !opts.watch ? 0 : 1));
  }

  if (opts._unknown) {
    console.error(`Unknown option: ${opts._unknown}\nRun "node controller.js --help" for usage.`);
    process.exit(1);
  }

  // Auto-scale the per-command timeout to the verb unless the caller forced one.
  // (Watch mode has no verb; it doesn't issue timed commands.)
  const effectiveTimeout = opts.timeoutExplicit ? opts.timeout : timeoutForVerb(opts._[0]);
  const ctrl = new Controller({ url: opts.url, name: 'cli', timeout: effectiveTimeout });

  // Connect once. A clear message if the bridge isn't up.
  try {
    await ctrl.connect();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  // --- watch mode: stream events until Ctrl-C ---
  if (opts.watch) {
    console.error(`# watching events from ${opts.url} (Ctrl-C to stop)`);
    ctrl.on('*', (data, full) => {
      console.log(pretty({ ts: new Date().toISOString(), name: full.name, data }));
    });
    const bye = () => { ctrl.close(); process.exit(0); };
    process.on('SIGINT', bye);
    process.on('SIGTERM', bye);
    return; // keep the process alive on the open socket
  }

  // --- single command mode ---
  const verb = opts._[0];
  let args = {};
  if (opts._.length > 1) {
    try {
      args = JSON.parse(opts._[1]);
    } catch (e) {
      console.error(`Invalid jsonArgs (must be a JSON object): ${e.message}`);
      ctrl.close();
      process.exit(1);
    }
  }

  try {
    const result = await ctrl.send(verb, args, opts.target);
    console.log(pretty(opts.raw ? result : result.data));
    ctrl.close();
    process.exit(0);
  } catch (err) {
    // ok:false carries the editor's error in err.result; timeouts set err.timeout.
    if (err.result) console.error(pretty({ ok: false, error: err.result.error }));
    else console.error(pretty({ ok: false, error: err.message }));
    ctrl.close();
    process.exit(1);
  }
}

// Only run the CLI when invoked directly (not when require()'d as a library).
if (require.main === module) {
  cliMain().catch((err) => { console.error(err && err.message || err); process.exit(1); });
}
