'use strict';
/*
 * acceptance-show.js — end-to-end regression guard for the AI-control BASE.
 *
 * Lays out a realistic show against the LIVE editor and asserts the result, so a
 * single `node test/acceptance-show.js` proves the whole composing pipeline still
 * works after any change to control.js / multitrack.js / the bridge:
 *
 *   newProject  -> clean slate
 *   layInShow   -> 3 tracks (VO main, Music bed, Outro@40s)
 *   batch       -> fadeClip bed in2/out3, outro in1, VO out2 ; duckMusicUnderVoice -14dB
 *   getBoard    -> assert tracks/positions/fades/ducked volume
 *   export      -> assert the multitrack bounce returns ok
 *
 * Requires: bridge on ws://127.0.0.1:8077 and ONE editor connected (open
 * http://127.0.0.1:5056/ai-control/editor.html). Exit 0 = all pass, 1 = a failure.
 *
 * It drives ONLY the public verbs over the bridge (no DOM/screenshot/fs reliance),
 * so it is a faithful check of what an AI controller can actually do — locally or cloud.
 */
const { Controller } = require('../controller.js');

const URL = '/ai-control/demo-weather.mp3'; // stand-in clip (only sample we have)
const checks = [];
function assert(name, cond, detail) {
  checks.push({ name, pass: !!cond, detail: detail === undefined ? '' : detail });
  console.log(`${cond ? '✓' : '✗'} ${name}${detail !== undefined ? '  (' + detail + ')' : ''}`);
}
const near = (a, b, tol) => typeof a === 'number' && Math.abs(a - b) <= tol;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// newProject reloads the editor page; wait for it to re-register, then continue.
async function newProjectAndWait(c) {
  let connected = 0;
  const off = c.on('EditorConnected', () => { connected++; });
  await c.send('newProject').catch(() => {}); // acks {reloading:true}, then the page reloads
  const deadline = Date.now() + 15000;
  while (connected < 1 && Date.now() < deadline) await sleep(300);
  off();
  await sleep(600);
  for (let i = 0; i < 20; i++) {
    try { await c.send('getProject'); return; } catch (_) { await sleep(400); }
  }
  throw new Error('editor did not come back after newProject');
}

function trackByName(board, name) {
  return (board.tracks || []).find((t) => t.name === name) || null;
}

(async () => {
  const c = new Controller({ name: 'acceptance', timeout: 120000 });
  await c.connect();

  const eds = (await c.send('listEditors')).data || [];
  assert('an editor is connected', eds.length >= 1, `${eds.length} editor(s)`);
  if (!eds.length) { c.close(); process.exit(1); }

  // 1) clean slate
  await newProjectAndWait(c);

  // 2) lay out the show
  await c.send('layInShow', { layout: { tracks: [
    { name: 'VO',    clips: [{ url: URL, at: 0 }] },
    { name: 'Music', clips: [{ url: URL, at: 0 }] },
    { name: 'Outro', clips: [{ url: URL, at: 40 }] }
  ] } });

  let board = (await c.send('getBoard')).data;
  const vo0 = trackByName(board, 'VO');
  const mus0 = trackByName(board, 'Music');
  const out0 = trackByName(board, 'Outro');
  assert('exactly 3 tracks, no orphans', (board.tracks || []).length === 3, `${(board.tracks || []).length} tracks`);
  assert('VO/Music/Outro tracks exist', vo0 && mus0 && out0);
  assert('Outro clip placed at ~40s', out0 && out0.clips[0] && near(out0.clips[0].startSec, 40, 0.2),
    out0 && out0.clips[0] ? out0.clips[0].startSec.toFixed(2) + 's' : 'no clip');

  const voClip = vo0.clips[0], musClip = mus0.clips[0], outClip = out0.clips[0];

  // 3) fades + duck, in one batch
  const batch = (await c.send('batch', { steps: [
    { verb: 'fadeClip', args: { clipId: musClip.id, inSecs: 2, outSecs: 3 } },
    { verb: 'fadeClip', args: { clipId: outClip.id, inSecs: 1 } },
    { verb: 'fadeClip', args: { clipId: voClip.id, outSecs: 2 } },
    { verb: 'duckMusicUnderVoice', args: { voiceTrackId: vo0.id, musicTrackId: mus0.id, underDb: 14 } }
  ] })).data;
  assert('batch completed all 4 ops', batch.completed === 4, `${batch.completed}/4`);

  // 4) verify the resulting arrangement
  board = (await c.send('getBoard')).data;
  const vo = trackByName(board, 'VO'), mus = trackByName(board, 'Music'), out = trackByName(board, 'Outro');
  assert('VO faded out ~2s', vo && near(vo.clips[0].fadeOut, 2, 0.1), vo && vo.clips[0].fadeOut.toFixed(2));
  assert('Music faded in ~2s', mus && near(mus.clips[0].fadeIn, 2, 0.1), mus && mus.clips[0].fadeIn.toFixed(2));
  assert('Music faded out ~3s', mus && near(mus.clips[0].fadeOut, 3, 0.1), mus && mus.clips[0].fadeOut.toFixed(2));
  assert('Outro faded in ~1s', out && near(out.clips[0].fadeIn, 1, 0.1), out && out.clips[0].fadeIn.toFixed(2));
  assert('Music ducked to ~0.20 (-14dB)', mus && near(mus.vol, 0.1995, 0.03), mus && mus.vol.toFixed(3));

  // 5) bounce the multitrack mix
  const exp = (await c.send('export', { format: 'mp3', name: 'acceptance-show' })).data;
  assert('export (bounce) returned ok', exp && exp.exported === true);

  const failed = checks.filter((c) => !c.pass).length;
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  c.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('acceptance error:', e && e.message ? e.message : e); process.exit(1); });
