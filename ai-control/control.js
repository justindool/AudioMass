'use strict';
/*
 * control.js — the in-page control client for AI-controllable AudioMass.
 *
 * Lifecycle:
 *   1. Poll until window.PKAudioEditor exists (the editor singleton from app.js).
 *   2. Open a WebSocket to the bridge (ws://127.0.0.1:8077), register as an editor,
 *      and auto-reconnect every ~2s if the socket ever drops.
 *   3. Handle incoming {type:'command', reqId, verb, args} by looking verb up in the
 *      VERBS dispatch table, executing it, and replying with a {type:'result', ...}.
 *   4. Forward a curated set of Did* notifications from the PKAudioEditor event bus to
 *      the bridge as {type:'event', name, data}.
 *
 * Protocol mirrors ai-control/bridge.js exactly.
 *
 * Grounding (read from src/app.js, src/engine.js, src/actions.js, src/multitrack.js,
 * src/ui-fx.js, src/lufs.js):
 *   - app.fireEvent(name, a, b) dispatches an event; when multitrack is ON and name
 *     starts with "Request", it is auto-routed through multitrack.Propagate(name,a,b)
 *     first (app.js lines 18-35). So the same Request* event drives single-track and
 *     multitrack alike — we never branch on mode for the action verbs.
 *   - Selection in single-track: wavesurfer.regions.list[0] with .start/.end (seconds).
 *   - RequestSeekTo expects a FRACTION (0..1), not seconds (engine.js seekTo; multitrack
 *     SeekTo both multiply by duration). We convert {time} seconds -> fraction.
 *   - RequestRegionSet(start, end) takes seconds and works in both modes
 *     (engine.js ~1003, multitrack.js ~5414).
 *   - RequestActionFX_GAIN expects [{val:<linear multiplier>}] (ui-fx.js ~167); 1.0 = no
 *     change. We convert {db} -> linear via 10^(db/20).
 *   - RequestActionFX_NormalizeLUFS expects an object; lufsNormalizeGain (actions.js ~1271)
 *     uses val.gain if present, otherwise computes from val.target / val.ceiling via
 *     PKAE._deps.lufs.gainForTarget. We pass {target, ceiling}.
 *   - RequestActionFX_FadeIn / _FadeOut take no meaningful arg (actions.js FadeIn()/FadeOut()
 *     ignore the value); they act on the current region or the whole clip if none.
 *   - RequestZoomUI(0) resets zoom (engine.js ~3764).
 */
(function ( w, d ) {

	var BRIDGE_URL  = 'ws://127.0.0.1:8077';
	var RECONNECT_MS = 2000;
	var POLL_MS      = 200;

	var ws = null;
	var connected = false;
	var app = null; // window.PKAudioEditor once ready

	function log () {
		try { console.log.apply (console, ['[control]'].concat ([].slice.call (arguments))); } catch (_) {}
	}

	// ---- small helpers over the live editor / wavesurfer -------------------

	function wavesurfer () {
		return app && app.engine && app.engine.wavesurfer ? app.engine.wavesurfer : null;
	}

	function multitrackOn () {
		return !!(app && app.multitrack && app.multitrack.IsOn && app.multitrack.IsOn ());
	}

	function isReady () {
		return !!(app && app.engine && app.engine.is_ready);
	}

	// Returns {start,end} in seconds, or null. Honors multitrack region when MT is on.
	function selection () {
		if (multitrackOn ()) {
			var r = app.multitrack.GetRegion && app.multitrack.GetRegion ();
			if (!r) return null;
			return { start: +r.start, end: +r.end };
		}
		var wv = wavesurfer ();
		var reg = wv && wv.regions && wv.regions.list && wv.regions.list[0];
		if (!reg) return null;
		return { start: +reg.start, end: +reg.end };
	}

	function duration () {
		if (multitrackOn () && app.multitrack.GetDuration) return +app.multitrack.GetDuration () || 0;
		var wv = wavesurfer ();
		return wv ? (+wv.getDuration () || 0) : 0;
	}

	function playhead () {
		if (multitrackOn () && app.multitrack.GetCursor) return +app.multitrack.GetCursor () || 0;
		var wv = wavesurfer ();
		return wv ? (+wv.getCurrentTime () || 0) : 0;
	}

	function loaded () {
		if (multitrackOn ()) return !!(app.multitrack.HasClips && app.multitrack.HasClips ());
		return isReady ();
	}

	function engine () {
		return app && app.engine ? app.engine : null;
	}

	// ---- multitrack helpers ------------------------------------------------
	// The PKMultitrack instance (src/multitrack.js) exposes a *narrow* public API
	// on the object stored at app.multitrack:
	//   Toggle(force), IsOn(), GetRegion(), GetCursor(), GetDuration(), HasClips(),
	//   getState()  -> full {tracks:[{id,name,mute,solo,vol,pan,h,rec}], clips:[{id,track,start,in,out,fi,fo,name,buffer}], ...}
	//   MixerData() -> {on, tracks:[{id,name,mute,solo,rec,sel,vol,pan,meter}], master},
	//   MixerSet(id,key,val,done) -> mutate vol|pan|mute|solo|rec|select (the SUPPORTED mutators),
	//   AddFilesAuto(fileList), Propagate(id,a,b).
	// There is NO public addTrack/removeTrack/renameTrack/addClip/moveClip/removeClip;
	// those are private closures. We drive them through the same DOM controls / Request*
	// events the human UI uses (verified against multitrack.js), and read results back
	// via getState(). Anything not reachable that way returns an informative error.

	function mt () {
		return (app && app.multitrack) ? app.multitrack : null;
	}

	function requireMT () {
		var m = mt ();
		if (!m) throw new Error ('multitrack module unavailable (app.multitrack not initialized)');
		if (!m.IsOn || !m.IsOn ()) throw new Error ('multitrack mode is OFF; call enableMultitrack({on:true}) first');
		return m;
	}

	// Snapshot of the live track/clip model via the public getState() (=cloneState).
	function mtState () {
		var m = mt ();
		if (!m || !m.getState) return null;
		try { return m.getState (); } catch ( _ ) { return null; }
	}

	function findMtTrack ( id ) {
		var st = mtState ();
		if (!st || !st.tracks) return null;
		for (var i = 0; i < st.tracks.length; ++i)
			if (st.tracks[i].id === id) return st.tracks[i];
		return null;
	}

	function findMtClip ( id ) {
		var st = mtState ();
		if (!st || !st.clips) return null;
		for (var i = 0; i < st.clips.length; ++i)
			if (st.clips[i].id === id) return st.clips[i];
		return null;
	}

	// Clean, serializable track summary (drops the heavy live AudioBuffer on clips).
	function summarizeTrack ( t, clips ) {
		var cl = [];
		for (var i = 0; i < clips.length; ++i) {
			var c = clips[i];
			if (c.track !== t.id) continue;
			var inn = c.in || 0;
			var out = (c.out === undefined && c.buffer) ? c.buffer.duration : c.out;
			cl.push ({
				id:    c.id,
				name:  c.name,
				start: c.start || 0,
				in:    inn,
				out:   out,
				len:   (typeof out === 'number') ? Math.max (0, out - inn) : null,
				fadeIn:  c.fi || 0,
				fadeOut: c.fo || 0
			});
		}
		return {
			id:    t.id,
			name:  t.name,
			mute:  !!t.mute,
			solo:  !!t.solo,
			vol:   t.vol === undefined ? 1 : t.vol,
			pan:   t.pan || 0,
			rec:   !!t.rec,
			clips: cl
		};
	}

	function mtTracks () {
		var st = mtState ();
		if (!st || !st.tracks) return [];
		var clips = st.clips || [];
		return st.tracks.map (function ( t ) { return summarizeTrack ( t, clips ); });
	}

	// The multitrack track row in the DOM: <div class="pk_mt_track" data-track="ID">.
	function trackRow ( id ) {
		var rows = d.getElementsByClassName ('pk_mt_track');
		for (var i = 0; i < rows.length; ++i)
			if (rows[i].getAttribute ('data-track') === id) return rows[i];
		return null;
	}

	function clipEl ( id ) {
		var els = d.getElementsByClassName ('pk_mt_clip');
		for (var i = 0; i < els.length; ++i)
			if (els[i].getAttribute ('data-clip') === id) return els[i];
		return null;
	}

	// Rename a track by driving its row's name <input>. multitrack.js renderTrack wires
	// input.onchange to commit the new name (and pushState). We set the value and fire
	// a 'change' event so the same handler runs.
	function renameTrackDom ( id, name ) {
		var row = trackRow ( id );
		if (!row) throw new Error ('renameTrack: track row for ' + id + ' not found in DOM');
		var input = row.getElementsByTagName ('input')[0];
		if (!input) throw new Error ('renameTrack: name input not found on track row ' + id);
		input.value = name;
		input.dispatchEvent (new Event ('change', { bubbles: true }));
	}

	// Best-effort filename for a clip label, derived from the URL path.
	function fileNameFromUrl ( url ) {
		try {
			var clean = String (url).split ('?')[0].split ('#')[0];
			var base = clean.substring (clean.lastIndexOf ('/') + 1);
			return base || 'Audio';
		} catch ( _ ) {
			return 'Audio';
		}
	}

	// Dismiss any open AudioMass modal (welcome.js / "Open or append" / FX dialogs).
	// modal.js builds each modal as a <div class="pk_modal"> with a
	// <a class="pk_modal_cancel"> whose onclick calls q.Destroy(). Clicking every
	// open cancel button tears them all down. Returns how many we closed.
	function dismissModals () {
		var closed = 0;
		try {
			var cancels = d.getElementsByClassName ('pk_modal_cancel');
			// Live HTMLCollection shrinks as we Destroy; snapshot to a plain array first.
			var list = [].slice.call (cancels);
			for (var i = 0; i < list.length; ++i) {
				if (list[i] && list[i].onclick) { list[i].click (); ++closed; }
			}
		} catch ( _ ) {}
		return closed;
	}

	// Fetch a URL as an ArrayBuffer. Returns a Promise (control.js targets modern
	// browsers; the editor itself relies on fetch/Promise elsewhere).
	function fetchArrayBuffer ( url ) {
		return fetch (url, { credentials: 'same-origin' }).then (function ( res ) {
			if (!res.ok) throw new Error ('fetch failed: HTTP ' + res.status + ' for ' + url);
			return res.arrayBuffer ();
		});
	}

	// Run a command that resolves asynchronously. The verb's run() returns a
	// {__async:Promise} marker; the command handler awaits it and replies then.
	function async ( promise ) {
		return { __async: promise };
	}

	// ---- VERB DISPATCH TABLE ----------------------------------------------
	// Each entry: { help:String, run:function(args)->data }
	// Throwing inside run() (or returning normally) is caught by the command
	// handler, which turns it into ok:false / ok:true respectively.

	var VERBS = {

		getProject: {
			help: 'Return {loaded,duration,playhead,selection,multitrack} describing the current project state. When multitrack is ON, also returns tracks:[{id,name,mute,solo,vol,pan,rec,clips:[{id,name,start,in,out,len,fadeIn,fadeOut}]}].',
			run: function () {
				var out = {
					loaded:     loaded (),
					duration:   duration (),
					playhead:   playhead (),
					selection:  selection (),
					multitrack: multitrackOn ()
				};
				if (multitrackOn ()) out.tracks = mtTracks ();
				return out;
			}
		},

		getSelection: {
			help: 'Return the current selection {start,end} in seconds, or null if nothing is selected.',
			run: function () {
				return selection ();
			}
		},

		play: {
			help: 'Start playback (RequestPlay).',
			run: function () {
				app.fireEvent ('RequestPlay');
				return { playing: true };
			}
		},

		pause: {
			help: 'Pause playback (RequestPause).',
			run: function () {
				app.fireEvent ('RequestPause');
				return { playing: false };
			}
		},

		stop: {
			help: 'Stop playback and return the cursor to the start of the selection/track (RequestStop).',
			run: function () {
				app.fireEvent ('RequestStop');
				return { playing: false };
			}
		},

		seekTo: {
			help: 'Move the playhead to {time} seconds (RequestSeekTo, which takes a 0..1 fraction internally).',
			run: function ( args ) {
				var t = args && args.time;
				if (typeof t !== 'number' || isNaN (t)) throw new Error ('seekTo requires numeric args.time (seconds)');
				var dur = duration ();
				if (!(dur > 0)) throw new Error ('cannot seek: no audio loaded (duration is 0)');
				var frac = t / dur;
				if (frac < 0) frac = 0; else if (frac > 1) frac = 1;
				app.fireEvent ('RequestSeekTo', frac);
				return { time: frac * dur, fraction: frac };
			}
		},

		select: {
			help: 'Select a region from {start} to {end} (seconds) via RequestRegionSet.',
			run: function ( args ) {
				var s = args && args.start, e = args && args.end;
				if (typeof s !== 'number' || typeof e !== 'number' || isNaN (s) || isNaN (e))
					throw new Error ('select requires numeric args.start and args.end (seconds)');
				if (!loaded ()) throw new Error ('cannot select: no audio loaded');
				app.fireEvent ('RequestRegionSet', s, e);
				// RequestRegionSet snaps/normalizes; read back the actual region.
				return selection () || { start: s, end: e };
			}
		},

		clearSelection: {
			help: 'Clear any active selection (RequestRegionClear).',
			run: function () {
				app.fireEvent ('RequestRegionClear');
				return { selection: null };
			}
		},

		fadeIn: {
			help: 'Apply a fade-in over the current selection, or the whole clip if nothing is selected (RequestActionFX_FadeIn).',
			run: function () {
				if (!loaded ()) throw new Error ('cannot fade in: no audio loaded');
				app.fireEvent ('RequestActionFX_FadeIn');
				return { applied: 'fadeIn', range: selection () };
			}
		},

		fadeOut: {
			help: 'Apply a fade-out over the current selection, or the whole clip if nothing is selected (RequestActionFX_FadeOut).',
			run: function () {
				if (!loaded ()) throw new Error ('cannot fade out: no audio loaded');
				app.fireEvent ('RequestActionFX_FadeOut');
				return { applied: 'fadeOut', range: selection () };
			}
		},

		gain: {
			help: 'Apply a gain change of {db} decibels to the selection/whole clip (RequestActionFX_GAIN; db converted to a linear multiplier 10^(db/20)).',
			run: function ( args ) {
				var db = args && args.db;
				if (typeof db !== 'number' || isNaN (db)) throw new Error ('gain requires numeric args.db (decibels)');
				if (!loaded ()) throw new Error ('cannot apply gain: no audio loaded');
				var linear = Math.pow (10, db / 20);
				// engine.js -> AudioUtils.FXBank.Gain(val): val is an array of {val:<linear gain>}.
				app.fireEvent ('RequestActionFX_GAIN', [ { val: linear } ]);
				return { applied: 'gain', db: db, linear: linear, range: selection () };
			}
		},

		normalizeLUFS: {
			help: 'Loudness-normalize the selection/whole clip to {target} LUFS (optional {ceiling} dBTP, default -1.0) via RequestActionFX_NormalizeLUFS.',
			run: function ( args ) {
				var target = args && args.target;
				if (typeof target !== 'number' || isNaN (target)) throw new Error ('normalizeLUFS requires numeric args.target (LUFS)');
				if (!loaded ()) throw new Error ('cannot normalize: no audio loaded');
				// actions.js lufsNormalizeGain() needs the lufs dep to compute gain from target+ceiling.
				if (!(app._deps && app._deps.lufs)) throw new Error ('LUFS analysis unavailable (lufs dependency not loaded)');
				var ceiling = (args && typeof args.ceiling === 'number' && !isNaN (args.ceiling)) ? args.ceiling : -1.0;
				// engine.js RequestActionFX_NormalizeLUFS -> FXBank.NormalizeLUFS(val);
				// val.gain optional, else computed from val.target / val.ceiling.
				app.fireEvent ('RequestActionFX_NormalizeLUFS', { target: target, ceiling: ceiling });
				return { applied: 'normalizeLUFS', target: target, ceiling: ceiling, range: selection () };
			}
		},

		undo: {
			help: 'Undo the last action (StateRequestUndo).',
			run: function () {
				app.fireEvent ('StateRequestUndo');
				return { undone: true };
			}
		},

		redo: {
			help: 'Redo the last undone action (StateRequestRedo).',
			run: function () {
				app.fireEvent ('StateRequestRedo');
				return { redone: true };
			}
		},

		zoomReset: {
			help: 'Reset the waveform zoom to fit (RequestZoomUI type 0).',
			run: function () {
				app.fireEvent ('RequestZoomUI', 0);
				return { zoom: 'reset' };
			}
		},

		dismissModal: {
			help: 'Dismiss any open modal dialog (Welcome, Open/Append, FX dialogs) by clicking its cancel button. Returns {dismissed:<count>}.',
			run: function () {
				return { dismissed: dismissModals () };
			}
		},

		loadAudio: {
			help: 'Load audio into the editor from {url} (or {path}, treated as a same-origin URL). Fetches the bytes, then loads them through the editor\'s drag-drop ingest path (engine.LoadArrayBuffer). Resolves to a getProject-style snapshot once decoded {loaded:true,duration}.',
			run: function ( args ) {
				var url = args && (args.url || args.path);
				if (!url || typeof url !== 'string') throw new Error ('loadAudio requires args.url (a string URL); args.path is accepted as a same-origin URL');
				var eng = engine ();
				if (!eng || !eng.LoadArrayBuffer) throw new Error ('editor engine not ready (LoadArrayBuffer unavailable)');

				var wv = wavesurfer ();
				// A "Welcome to AudioMass" modal (welcome.js) or any leftover modal would
				// otherwise intercept the load; clear them first.
				dismissModals ();

				// engine.LoadArrayBuffer shows an "Open or append" modal when audio is
				// ALREADY loaded (is_ready). We always want a clean OPEN-NEW, so force the
				// backend into open-new mode and, if the modal still appears, dismiss it
				// after kicking the load — but the cleaner route is: when already ready,
				// drive the same internal load path with _add=0 and no modal by calling
				// LoadArrayBuffer and immediately answering its modal. To keep it simple and
				// faithful to the UI, we set _add=0 up front (matches the drag-drop path,
				// ui.js -> LoadArrayBuffer(new Blob([e]))).
				if (wv && wv.backend) { try { wv.backend._add = 0; } catch ( _ ) {} }

				var startReady = isReady ();

				var p = fetchArrayBuffer (url).then (function ( buf ) {
					if (!buf || !buf.byteLength) throw new Error ('fetched empty body for ' + url);

					return new Promise (function ( resolve, reject ) {
						var done = false;
						var timeoutMs = 30000;

						function finish ( ok, errMsg ) {
							if (done) return;
							done = true;
							app.stopListeningFor ('DidLoadFile', onLoad);
							app.stopListeningFor ('ShowError', onError);
							clearTimeout (timer);
							if (ok) {
								resolve ({
									loaded:     loaded (),
									duration:   duration (),
									playhead:   playhead (),
									selection:  selection (),
									multitrack: multitrackOn (),
									url:        url
								});
							} else {
								reject (new Error (errMsg || 'failed to load audio'));
							}
						}

						function onLoad () {
							// DidLoadFile fires from engine.js wavesurfer 'ready' once decoded.
							setTimeout (function () { finish (duration () > 0, 'audio loaded but duration is 0'); }, 30);
						}
						function onError ( msg ) {
							finish (false, 'decode/load error: ' + (msg && msg.message ? msg.message : msg));
						}

						app.listenFor ('DidLoadFile', onLoad);
						app.listenFor ('ShowError', onError);

						// Kick the load via the editor's own ingest path (same as drag-drop).
						try {
							eng.LoadArrayBuffer ( new Blob ([ buf ]) );
						} catch ( e ) {
							finish (false, 'LoadArrayBuffer threw: ' + (e && e.message ? e.message : e));
							return;
						}

						// If audio was already loaded, LoadArrayBuffer pops an "Open or append"
						// modal and waits. Click OPEN NEW for the caller (deterministic).
						if (startReady) {
							setTimeout (function () {
								try {
									var btns = d.getElementsByClassName ('pk_modal_a_bottom');
									for (var i = 0; i < btns.length; ++i) {
										var t = (btns[i].innerHTML || '').toUpperCase ();
										if (t.indexOf ('OPEN NEW') !== -1) { btns[i].click (); break; }
									}
								} catch ( _ ) {}
							}, 40);
						}

						var timer = setTimeout (function () {
							finish (false, 'timed out after ' + timeoutMs + 'ms waiting for DidLoadFile');
						}, timeoutMs);
					});
				});

				return async (p);
			}
		},

		measureLUFS: {
			help: 'Measure loudness of the current selection (or whole clip if none): returns the lufs.js report {lufs,rms,rmsDb,peak,peakDb,truePeak,truePeakDb,blocks}. READ-only, no mutation (RequestActionFX_Loudness).',
			run: function () {
				if (!loaded ()) throw new Error ('cannot measure: no audio loaded');
				if (!(app._deps && app._deps.lufs)) throw new Error ('LUFS analysis unavailable (lufs dependency not loaded)');
				if (multitrackOn ()) throw new Error ('measureLUFS is single-track only (multitrack analysis not wired)');
				// engine.js RequestActionFX_Loudness(done) calls done(report) synchronously
				// with AudioUtils.Loudness(start,len) -> lufs.analyze(...).
				var report = null;
				app.fireEvent ('RequestActionFX_Loudness', function ( r ) { report = r; });
				if (!report) throw new Error ('loudness analysis returned no report');
				return report;
			}
		},

		export: {
			help: 'Export/bounce the project to a file download. {format}=wav|mp3|flac (default wav), optional {name}, {kbps} (mp3), {selectionOnly:true} to export the selection, {stereo}, {bitDepth} (wav 16|24|32), {dither}. Triggers the browser download via engine.DownloadFile.',
			run: function ( args ) {
				if (!loaded ()) throw new Error ('cannot export: no audio loaded');
				var eng = engine ();
				if (!eng || !eng.DownloadFile) throw new Error ('export unavailable (engine.DownloadFile missing)');
				args = args || {};
				var format = (args.format || 'wav').toLowerCase ();
				if (['wav', 'mp3', 'flac'].indexOf (format) === -1)
					throw new Error ('export format must be one of wav, mp3, flac (got ' + format + ')');
				var name = args.name || ('output.' + format);
				if (name.indexOf ('.') === -1) name += '.' + format;
				var kbps = (typeof args.kbps === 'number') ? args.kbps : 128;
				// engine.DownloadFile(name, format, kbps, selection, stereo, bit_depth, dither)
				// selection is [start,end] in seconds, or false/undefined for whole clip.
				var sel = false;
				if (args.selectionOnly) {
					var s = selection ();
					if (!s) throw new Error ('selectionOnly requested but nothing is selected');
					sel = [ s.start, s.end ];
				}
				var stereo = args.stereo === undefined ? false : !!args.stereo;
				var bitDepth = (typeof args.bitDepth === 'number') ? args.bitDepth : 16;
				var dither = !!args.dither;

				// DownloadFile is async (worker-based) and fires DidDownloadFile when done.
				// We resolve when the encode finishes, or after a generous timeout.
				var p = new Promise (function ( resolve ) {
					var done = false;
					function finish () {
						if (done) return; done = true;
						app.stopListeningFor ('DidDownloadFile', onDone);
						clearTimeout (timer);
						resolve ({ exported: true, format: format, name: name, selection: sel || null });
					}
					function onDone () { setTimeout (finish, 10); }
					app.listenFor ('DidDownloadFile', onDone);
					try {
						eng.DownloadFile (name, format, kbps, sel, stereo, bitDepth, dither);
					} catch ( e ) {
						done = true;
						app.stopListeningFor ('DidDownloadFile', onDone);
						clearTimeout (timer);
						throw e;
					}
					var timer = setTimeout (finish, 60000);
				});
				return async (p);
			}
		},

		compressor: {
			help: 'Apply dynamics compression to the selection/whole clip (RequestActionFX_Compressor). Args: {threshold,knee,ratio,attack,release,makeup} numbers (sensible defaults applied); each is sent as {val:n}.',
			run: function ( args ) {
				if (!loaded ()) throw new Error ('cannot compress: no audio loaded');
				args = args || {};
				function v ( x, def ) { return { val: (typeof x === 'number' && !isNaN (x)) ? x : def }; }
				// ui-fx.js Compressor getvalue() builds {threshold,knee,ratio,attack,release,makeup}
				// each as {val:n}; makeup is in dB (FXBank.Compressor converts via 10^(dB/20)).
				var val = {
					threshold: v (args.threshold, -24),
					knee:      v (args.knee, 30),
					ratio:     v (args.ratio, 12),
					attack:    v (args.attack, 0.003),
					release:   v (args.release, 0.25),
					makeup:    v (args.makeup, 0)
				};
				app.fireEvent ('RequestActionFX_Compressor', val);
				return { applied: 'compressor', params: val, range: selection () };
			}
		},

		reverb: {
			help: 'Apply reverb to the selection/whole clip (RequestActionFX_REVERB). Args: {mix:0..1 (default 0.5), time:seconds (default 2), decay:number (default 2), reverse:bool}.',
			run: function ( args ) {
				if (!loaded ()) throw new Error ('cannot apply reverb: no audio loaded');
				args = args || {};
				// actions.js Reverb expects val.mix, val.time, val.decay, val.reverse.
				var val = {
					mix:     (typeof args.mix === 'number') ? args.mix : 0.5,
					time:    (typeof args.time === 'number') ? args.time : 2,
					decay:   (typeof args.decay === 'number') ? args.decay : 2,
					reverse: !!args.reverse
				};
				app.fireEvent ('RequestActionFX_REVERB', val);
				return { applied: 'reverb', params: val, range: selection () };
			}
		},

		paramEQ: {
			help: 'Apply a parametric EQ to the selection/whole clip (RequestActionFX_PARAMEQ). Args: {bands:[{type,freq,val,q}]} where type is peaking|lowshelf|highshelf|lowpass|highpass|notch, freq in Hz, val in dB, q number.',
			run: function ( args ) {
				if (!loaded ()) throw new Error ('cannot apply paramEQ: no audio loaded');
				args = args || {};
				var bands = args.bands;
				if (!Array.isArray (bands) || !bands.length)
					throw new Error ('paramEQ requires args.bands: a non-empty array of {type,freq,val,q}');
				// actions.js ParametricEQ(val): val is an array of band objects
				// {type, freq, val(dB), q}.
				var clean = bands.map (function ( b ) {
					return {
						type: b.type || 'peaking',
						freq: (typeof b.freq === 'number') ? b.freq : 1000,
						val:  (typeof b.val === 'number') ? b.val : 0,
						q:    (typeof b.q === 'number') ? b.q : 1
					};
				});
				app.fireEvent ('RequestActionFX_PARAMEQ', clean);
				return { applied: 'paramEQ', bands: clean, range: selection () };
			}
		},

		changeRate: {
			help: 'Resample-style rate change (pitch + speed together) on the selection/whole clip (RequestActionFX_RATE). Args: {rate} multiplier (e.g. 1.5 faster/higher, 0.5 slower/lower). NOTE: engine RATE handler exists but its render path is uncertain; returns a request acknowledgement.',
			run: function ( args ) {
				if (!loaded ()) throw new Error ('cannot change rate: no audio loaded');
				var rate = args && args.rate;
				if (typeof rate !== 'number' || isNaN (rate) || rate <= 0)
					throw new Error ('changeRate requires positive numeric args.rate');
				// ui-fx.js fires RequestActionFX_RATE with a bare number value.
				app.fireEvent ('RequestActionFX_RATE', rate);
				return { applied: 'changeRate', rate: rate, range: selection () };
			}
		},

		changeSpeed: {
			help: 'Time-stretch the selection/whole clip preserving pitch (RequestActionFX_SPEED). Args: {speed} multiplier (>1 faster, <1 slower). Async render in engine; returns immediately after firing.',
			run: function ( args ) {
				if (!loaded ()) throw new Error ('cannot change speed: no audio loaded');
				var speed = args && args.speed;
				if (typeof speed !== 'number' || isNaN (speed) || speed <= 0)
					throw new Error ('changeSpeed requires positive numeric args.speed');
				// ui-fx.js fires RequestActionFX_SPEED with a bare number (or a profile object).
				app.fireEvent ('RequestActionFX_SPEED', speed);
				return { applied: 'changeSpeed', speed: speed, range: selection () };
			}
		},

		hardLimit: {
			help: 'Apply a hard/brickwall limiter to the selection/whole clip (RequestActionFX_HardLimit). Args: {ceiling:0..1 linear (default 1.0), ratio:0..1 (default 0), lookAheadMs:number (default 15)}. val array = [equally, ceiling, ratio, lookAhead].',
			run: function ( args ) {
				if (!loaded ()) throw new Error ('cannot hard-limit: no audio loaded');
				args = args || {};
				// actions.js HardLimit(val): val[1]=max(ceiling linear), val[2]=ratio, val[3]=lookAhead ms.
				var ceiling = (typeof args.ceiling === 'number') ? args.ceiling : 1.0;
				var ratio   = (typeof args.ratio === 'number') ? args.ratio : 0;
				var look    = (typeof args.lookAheadMs === 'number') ? args.lookAheadMs : 15;
				var val = [ false, ceiling, ratio, look ];
				app.fireEvent ('RequestActionFX_HardLimit', val);
				return { applied: 'hardLimit', ceiling: ceiling, ratio: ratio, lookAheadMs: look, range: selection () };
			}
		},

		removeSilence: {
			help: 'Detect and remove silent gaps within the selection/whole clip (RequestActionFX_RemSil). No tunable args confirmed in source (thresholds are hard-coded in engine.js).',
			run: function () {
				if (!loaded ()) throw new Error ('cannot remove silence: no audio loaded');
				app.fireEvent ('RequestActionFX_RemSil');
				return { applied: 'removeSilence', range: selection () };
			}
		},

		deClick: {
			help: 'Remove clicks/pops from the selection/whole clip (RequestActionFX_DeClick). Args: {sensitivity} number passed straight through to the de-click detector.',
			run: function ( args ) {
				if (!loaded ()) throw new Error ('cannot de-click: no audio loaded');
				// engine.js RequestActionFX_DeClick(sens) — sensitivity value passed through.
				var sens = (args && typeof args.sensitivity === 'number') ? args.sensitivity : undefined;
				app.fireEvent ('RequestActionFX_DeClick', sens);
				return { applied: 'deClick', sensitivity: sens === undefined ? 'default' : sens, range: selection () };
			}
		},

		invert: {
			help: 'Invert the phase/polarity of the selection/whole clip (RequestActionFX_Invert).',
			run: function () {
				if (!loaded ()) throw new Error ('cannot invert: no audio loaded');
				app.fireEvent ('RequestActionFX_Invert');
				return { applied: 'invert', range: selection () };
			}
		},

		reverse: {
			help: 'Reverse the selection/whole clip in time (RequestActionFX_Reverse).',
			run: function () {
				if (!loaded ()) throw new Error ('cannot reverse: no audio loaded');
				app.fireEvent ('RequestActionFX_Reverse');
				return { applied: 'reverse', range: selection () };
			}
		},

		zoomIn: {
			help: 'Zoom the waveform in horizontally (RequestZoom with mode 1). Optional {amount} pixels of zoom delta (default 120).',
			run: function ( args ) {
				if (!loaded ()) throw new Error ('cannot zoom: no audio loaded');
				var amount = (args && typeof args.amount === 'number') ? args.amount : 120;
				// engine.js RequestZoom(diff, mode): mode 1 zooms in.
				app.fireEvent ('RequestZoom', amount, 1);
				return { zoom: 'in', amount: amount };
			}
		},

		zoomOut: {
			help: 'Zoom the waveform out horizontally (RequestZoom with mode -1). Optional {amount} pixels of zoom delta (default 120).',
			run: function ( args ) {
				if (!loaded ()) throw new Error ('cannot zoom: no audio loaded');
				var amount = (args && typeof args.amount === 'number') ? args.amount : 120;
				// engine.js RequestZoom(diff, mode): mode -1 zooms out.
				app.fireEvent ('RequestZoom', amount, -1);
				return { zoom: 'out', amount: amount };
			}
		},

		zoomTo: {
			help: 'Zoom so the given time {range:[start,end]} (seconds) is selected and then horizontally zoomed in around it. Selects the range then zooms in. (Best-effort: AudioMass has no direct fit-to-range verb.)',
			run: function ( args ) {
				if (!loaded ()) throw new Error ('cannot zoom: no audio loaded');
				var range = args && args.range;
				if (!Array.isArray (range) || range.length !== 2 || typeof range[0] !== 'number' || typeof range[1] !== 'number')
					throw new Error ('zoomTo requires args.range = [startSeconds, endSeconds]');
				// No native fit-to-range; select the range and zoom in around it.
				app.fireEvent ('RequestRegionSet', range[0], range[1]);
				app.fireEvent ('RequestZoom', 240, 1);
				return { zoom: 'to', range: selection () };
			}
		},

		centerToCursor: {
			help: 'Scroll the view so the playback cursor is centered (RequestViewCenterToCursor).',
			run: function () {
				if (!loaded ()) throw new Error ('cannot center: no audio loaded');
				app.fireEvent ('RequestViewCenterToCursor');
				return { centered: true, playhead: playhead () };
			}
		},

		pan: {
			help: 'Pan/scroll the waveform horizontally (RequestPan). Args: {amount} pixels to pan (positive scrolls right). Only meaningful while zoomed in.',
			run: function ( args ) {
				if (!loaded ()) throw new Error ('cannot pan: no audio loaded');
				var amount = args && args.amount;
				if (typeof amount !== 'number' || isNaN (amount)) throw new Error ('pan requires numeric args.amount (pixels)');
				// engine.js RequestPan(diff, mode): default mode pans by visible-duration fraction.
				app.fireEvent ('RequestPan', amount);
				return { panned: amount };
			}
		},

		addMarker: {
			help: 'Add a marker at {time} seconds (default: current playhead) with optional {label} and {color} (#rgb/#rrggbb). Uses the MrkrAdd event (markers.js). Single-track only.',
			run: function ( args ) {
				if (!loaded ()) throw new Error ('cannot add marker: no audio loaded');
				if (!app.mrk) throw new Error ('markers unavailable (app.mrk not initialized)');
				args = args || {};
				// markers.js drop(o): o.time present -> add at time; else at current cursor.
				var o = {};
				if (typeof args.time === 'number' && !isNaN (args.time)) o.time = args.time;
				if (typeof args.label === 'string') o.name = args.label;
				if (typeof args.color === 'string') o.color = args.color;
				app.fireEvent ('MrkrAdd', o);
				// Read back the (single-track) marker list so the caller sees the result.
				var list = app.mrk.serEd ? app.mrk.serEd () : [];
				return { added: true, markers: list };
			}
		},

		listMarkers: {
			help: 'List all single-track markers as [{id,time,name,color,loop}] (markers.js serEd()).',
			run: function () {
				if (!app.mrk || !app.mrk.serEd) throw new Error ('markers unavailable (app.mrk not initialized)');
				return app.mrk.serEd ();
			}
		},

		clearMarkers: {
			help: 'Remove all single-track markers (markers.js clearEd()). Returns {cleared:bool}.',
			run: function () {
				if (!app.mrk || !app.mrk.clearEd) throw new Error ('markers unavailable (app.mrk not initialized)');
				var did = app.mrk.clearEd ();
				return { cleared: !!did };
			}
		},

		// ---- MULTITRACK -----------------------------------------------------

		enableMultitrack: {
			help: 'Enter or leave multitrack mode. Args: {on} (default true). Calls app.multitrack.Toggle(on). Returns {multitrack:<bool>, tracks:[...] }.',
			run: function ( args ) {
				var m = mt ();
				if (!m || !m.Toggle) throw new Error ('multitrack module unavailable (app.multitrack.Toggle missing)');
				var on = !(args && args.on === false); // default true
				// multitrack.js Toggle(force) sets mode to !!force when force is defined.
				m.Toggle ( on );
				return { multitrack: multitrackOn (), tracks: multitrackOn () ? mtTracks () : [] };
			}
		},

		addTrack: {
			help: 'Add a new (empty) channel/track. Optional {name} renames it after creation. Returns the new track {id,name,mute,solo,vol,pan,rec,clips}. (Drives the "+" Add Channel button; multitrack.js exposes no public addTrack.)',
			run: function ( args ) {
				requireMT ();
				var before = mtTracks ().map (function ( t ) { return t.id; });
				// The "+" header button's onclick === addTrack() (multitrack.js buildHeader).
				var add = d.getElementsByClassName ('pk_mt_add')[0];
				if (!add) throw new Error ('Add Channel button (.pk_mt_add) not found in DOM');
				add.click ();
				// Find the track id that appeared (addTrack pushes one new track).
				var after = mtTracks ();
				var created = null;
				for (var i = 0; i < after.length; ++i) {
					if (before.indexOf (after[i].id) === -1) { created = after[i]; break; }
				}
				if (!created) throw new Error ('addTrack: clicked Add Channel but no new track appeared in state');
				if (args && typeof args.name === 'string' && args.name.trim ()) {
					renameTrackDom ( created.id, args.name.trim () );
					created = findMtTrack (created.id);
					created = created ? summarizeTrack (created, (mtState () || {}).clips || []) : null;
				}
				return created;
			}
		},

		removeTrack: {
			help: 'Remove a channel/track by {id} (and its clips). Returns {removed:<id>, tracks:[...]}. NOTE: multitrack.js refuses to remove the last remaining track (needs >= 2 tracks).',
			run: function ( args ) {
				requireMT ();
				var id = args && args.id;
				if (!id || typeof id !== 'string') throw new Error ('removeTrack requires args.id (track id string)');
				if (!findMtTrack (id)) throw new Error ('removeTrack: no track with id ' + id);
				if (mtTracks ().length < 2) throw new Error ('cannot remove the last track (multitrack.js keeps at least one)');
				var row = trackRow (id);
				if (!row) throw new Error ('removeTrack: track row for ' + id + ' not found in DOM');
				// Each row has a .pk_mt_del button whose onclick === removeTrack(track).
				var del = row.getElementsByClassName ('pk_mt_del')[0];
				if (!del) throw new Error ('removeTrack: delete button (.pk_mt_del) not found on row');
				del.click ();
				if (findMtTrack (id)) throw new Error ('removeTrack: clicked delete but track ' + id + ' still present');
				return { removed: id, tracks: mtTracks () };
			}
		},

		renameTrack: {
			help: 'Rename channel/track {id} to {name}. Returns the updated track summary. (Drives the track-row name input change handler.)',
			run: function ( args ) {
				requireMT ();
				var id = args && args.id, name = args && args.name;
				if (!id || typeof id !== 'string') throw new Error ('renameTrack requires args.id');
				if (typeof name !== 'string' || !name.trim ()) throw new Error ('renameTrack requires non-empty args.name');
				if (!findMtTrack (id)) throw new Error ('renameTrack: no track with id ' + id);
				renameTrackDom ( id, name.trim () );
				var t = findMtTrack (id);
				if (!t || t.name !== name.trim ())
					throw new Error ('renameTrack: name did not update (got "' + (t && t.name) + '")');
				return summarizeTrack ( t, (mtState () || {}).clips || [] );
			}
		},

		muteTrack: {
			help: 'Mute/unmute channel/track {id}. Args: {id, on} (on default true). Uses app.multitrack.MixerSet(id,"mute",on). Returns the updated track summary.',
			run: function ( args ) {
				var m = requireMT ();
				var id = args && args.id;
				if (!id || typeof id !== 'string') throw new Error ('muteTrack requires args.id');
				if (!findMtTrack (id)) throw new Error ('muteTrack: no track with id ' + id);
				var on = !(args && args.on === false); // default true
				if (!m.MixerSet) throw new Error ('app.multitrack.MixerSet unavailable');
				m.MixerSet ( id, 'mute', on, true );
				var t = findMtTrack (id);
				return summarizeTrack ( t, (mtState () || {}).clips || [] );
			}
		},

		soloTrack: {
			help: 'Solo/unsolo channel/track {id}. Args: {id, on} (on default true). Uses app.multitrack.MixerSet(id,"solo",on). Soloing one or more tracks silences the rest — the basis for "solo only these" version compares. Returns the updated track summary.',
			run: function ( args ) {
				var m = requireMT ();
				var id = args && args.id;
				if (!id || typeof id !== 'string') throw new Error ('soloTrack requires args.id');
				if (!findMtTrack (id)) throw new Error ('soloTrack: no track with id ' + id);
				var on = !(args && args.on === false); // default true
				if (!m.MixerSet) throw new Error ('app.multitrack.MixerSet unavailable');
				m.MixerSet ( id, 'solo', on, true );
				var t = findMtTrack (id);
				return summarizeTrack ( t, (mtState () || {}).clips || [] );
			}
		},

		setTrackVolume: {
			help: 'Set channel/track {id} volume from {db} decibels (0 dB = unity). Internally MixerSet expects a 0..1 linear fader; db is mapped via 10^(db/20) and clamped to [0,1] (multitrack vol range). Pass {linear:0..1} to set the fader directly instead. Returns the updated track summary.',
			run: function ( args ) {
				var m = requireMT ();
				var id = args && args.id;
				if (!id || typeof id !== 'string') throw new Error ('setTrackVolume requires args.id');
				if (!findMtTrack (id)) throw new Error ('setTrackVolume: no track with id ' + id);
				if (!m.MixerSet) throw new Error ('app.multitrack.MixerSet unavailable');
				var linear;
				if (args && typeof args.linear === 'number' && !isNaN (args.linear)) {
					linear = args.linear;
				} else if (args && typeof args.db === 'number' && !isNaN (args.db)) {
					linear = Math.pow (10, args.db / 20);
				} else {
					throw new Error ('setTrackVolume requires numeric args.db (decibels) or args.linear (0..1 fader)');
				}
				// multitrack.js MixerSet clamps vol to [0,1]; >0 dB (linear>1) saturates at unity.
				if (linear < 0) linear = 0; else if (linear > 1) linear = 1;
				m.MixerSet ( id, 'vol', linear, true );
				var t = findMtTrack (id);
				return summarizeTrack ( t, (mtState () || {}).clips || [] );
			}
		},

		setTrackPan: {
			help: 'Set channel/track {id} stereo pan {x} in -1 (hard left) .. +1 (hard right), 0 = center. Uses app.multitrack.MixerSet(id,"pan",x). Returns the updated track summary.',
			run: function ( args ) {
				var m = requireMT ();
				var id = args && args.id;
				if (!id || typeof id !== 'string') throw new Error ('setTrackPan requires args.id');
				if (!findMtTrack (id)) throw new Error ('setTrackPan: no track with id ' + id);
				var x = args && args.x;
				if (typeof x !== 'number' || isNaN (x)) throw new Error ('setTrackPan requires numeric args.x (-1..1)');
				if (x < -1) x = -1; else if (x > 1) x = 1; // multitrack.js clamps to [-1,1]
				if (!m.MixerSet) throw new Error ('app.multitrack.MixerSet unavailable');
				m.MixerSet ( id, 'pan', x, true );
				var t = findMtTrack (id);
				return summarizeTrack ( t, (mtState () || {}).clips || [] );
			}
		},

		addClip: {
			help: 'Lay an audio file onto the timeline as a clip. Args: {trackId, url, at}. Fetches the URL, then loads it as a clip onto track {trackId} starting at {at} seconds (default 0). THIS is the verb for placing generated files on the timeline. Resolves to {clipId,track,start,len,name} once decoded. Implemented via select-track + seek-marker + RequestLoadPickedFiles (the same path the UI uses; multitrack exposes no direct addClip).',
			run: function ( args ) {
				var m = requireMT ();
				var trackId = args && args.trackId;
				var url     = args && (args.url || args.path);
				var at      = (args && typeof args.at === 'number' && !isNaN (args.at)) ? Math.max (0, args.at) : 0;
				if (!trackId || typeof trackId !== 'string') throw new Error ('addClip requires args.trackId (track id string)');
				if (!url || typeof url !== 'string') throw new Error ('addClip requires args.url (a string URL)');
				if (!findMtTrack (trackId)) throw new Error ('addClip: no track with id ' + trackId);
				if (!m.MixerSet) throw new Error ('app.multitrack.MixerSet unavailable (cannot target track)');

				var clipIdsBefore = ((mtState () || {}).clips || []).map (function ( c ) { return c.id; });

				// 1) Make the target track the selected track. multitrack.js addFiles uses
				//    selected_track when invoked through RequestLoadPickedFiles.
				m.MixerSet ( trackId, 'select' );

				// 2) Move the multitrack cursor/marker to `at`. multitrack.js addFiles places
				//    the clip at `marker` (set by SeekTo -> setCursorTime). SeekTo takes a 0..1
				//    fraction of the project duration.
				var dur = duration ();
				// duration() floors at 30s in multitrack; if `at` exceeds it the clip would clamp.
				var frac = (dur > 0) ? (at / dur) : 0;
				if (frac < 0) frac = 0; else if (frac > 1) frac = 1;
				app.fireEvent ('RequestSeekTo', frac);

				var p = fetchArrayBuffer (url).then (function ( buf ) {
					if (!buf || !buf.byteLength) throw new Error ('fetched empty body for ' + url);
					return new Promise (function ( resolve, reject ) {
						var done = false;
						var timeoutMs = 30000;
						var nameGuess = fileNameFromUrl ( url );

						function finish ( clip, errMsg ) {
							if (done) return;
							done = true;
							app.stopListeningFor ('DidUpdateMultitrack', onUpdate);
							clearTimeout (timer);
							if (clip) {
								resolve ({
									clipId: clip.id,
									track:  clip.track,
									start:  clip.start,
									len:    clip.len,
									name:   clip.name
								});
							} else {
								reject (new Error (errMsg || 'addClip: clip did not appear'));
							}
						}

						function newestClip () {
							var clips = (mtState () || {}).clips || [];
							for (var i = 0; i < clips.length; ++i) {
								if (clipIdsBefore.indexOf (clips[i].id) === -1) {
									// Reuse summarizeTrack's clip shaping by faking a one-clip track.
									var c = clips[i];
									var inn = c.in || 0;
									var out = (c.out === undefined && c.buffer) ? c.buffer.duration : c.out;
									return {
										id: c.id, track: c.track, start: c.start || 0, name: c.name,
										len: (typeof out === 'number') ? Math.max (0, out - inn) : null
									};
								}
							}
							return null;
						}

						function onUpdate () {
							var c = newestClip ();
							if (c) finish (c, null);
						}

						// addFiles fires DidUpdateMultitrack after the clip is decoded+placed.
						app.listenFor ('DidUpdateMultitrack', onUpdate);

						// 3) Build a Blob that looks like a dropped File (addFiles reads file.name
						//    and FileReader.readAsArrayBuffer(file) works on a Blob), then drive
						//    the documented RequestLoadPickedFiles path:
						//      Propagate('RequestLoadPickedFiles', files) ->
						//      addFiles(files, selected_track, marker).
						var blob;
						try {
							blob = new Blob ([ buf ]);
							try { blob.name = nameGuess; } catch ( _ ) {} // some engines: name is read-only on Blob
						} catch ( e ) {
							finish (null, 'addClip: could not build Blob: ' + (e && e.message ? e.message : e));
							return;
						}
						// If name is read-only (native File), fall back to a File when available.
						if (blob.name !== nameGuess && w.File) {
							try { blob = new w.File ([ buf ], nameGuess); } catch ( _ ) {}
						}

						try {
							app.fireEvent ('RequestLoadPickedFiles', [ blob ]);
						} catch ( e ) {
							finish (null, 'addClip: RequestLoadPickedFiles threw: ' + (e && e.message ? e.message : e));
							return;
						}

						// In case the update fired synchronously before we could observe it.
						var immediate = newestClip ();
						if (immediate) { finish (immediate, null); return; }

						var timer = setTimeout (function () {
							var late = newestClip ();
							finish (late, late ? null : 'addClip: timed out after ' + timeoutMs + 'ms (decode/place failed?)');
						}, timeoutMs);
					});
				});

				return async (p);
			}
		},

		moveClip: {
			help: 'Move clip {id} to start at {at} seconds, optionally onto {trackId}. BEST-EFFORT: multitrack.js exposes no public clip-move and clip drag is mouse-driven. Returns an informative error if it cannot be performed deterministically. (Use removeClip + addClip for a reliable reposition.)',
			run: function ( args ) {
				requireMT ();
				var id = args && args.id;
				if (!id || typeof id !== 'string') throw new Error ('moveClip requires args.id (clip id)');
				if (!findMtClip (id)) throw new Error ('moveClip: no clip with id ' + id);
				// Uncertainty: clip repositioning in multitrack.js happens only via bindClipDrag
				// (mousedown/mousemove with snap logic) and has no public/event entry point.
				// Synthesizing pixel-accurate drag events is not deterministic here, so rather
				// than silently no-op we report this clearly. The reliable primitive for
				// repositioning is removeClip(id) followed by addClip({trackId,url,at}).
				throw new Error ('moveClip is not deterministically supported: multitrack.js has no public/event clip-move (drag is mouse-only). Reposition by removeClip + addClip instead.');
			}
		},

		removeClip: {
			help: 'Remove clip {id} from the timeline. BEST-EFFORT: selects the clip element in the DOM then fires RequestActionCut (delete). multitrack.js has no remove-clip-by-id API, so this depends on the clip being clickable; returns an informative error if the clip cannot be confirmed removed.',
			run: function ( args ) {
				requireMT ();
				var id = args && args.id;
				if (!id || typeof id !== 'string') throw new Error ('removeClip requires args.id (clip id)');
				if (!findMtClip (id)) throw new Error ('removeClip: no clip with id ' + id);
				var ce = clipEl (id);
				if (!ce) throw new Error ('removeClip: clip element [data-clip=' + id + '] not found in DOM (is multitrack rendered?)');

				// Select the clip: a shift+mousedown on the clip element calls selectClip(clip)
				// (multitrack.js bindClipDrag). We dispatch a synthetic shift-click sequence.
				// Uncertainty: this relies on the clip-drag select branch; if selection does not
				// take, we abort rather than deleting the wrong clip.
				try {
					var rect = ce.getBoundingClientRect ();
					var cx = rect.left + Math.min (8, rect.width / 2);
					var cy = rect.top + rect.height / 2;
					['mousedown', 'mouseup', 'click'].forEach (function ( type ) {
						ce.dispatchEvent (new MouseEvent (type, {
							bubbles: true, cancelable: true, view: w,
							clientX: cx, clientY: cy, button: 0, shiftKey: true
						}));
					});
				} catch ( e ) {
					throw new Error ('removeClip: could not synthesize clip selection: ' + (e && e.message ? e.message : e));
				}

				// RequestActionCut with no arg + no active region deletes the selected clip
				// (multitrack.js Propagate -> deleteSelectedClip()).
				app.fireEvent ('RequestActionCut');

				if (findMtClip (id))
					throw new Error ('removeClip: fired delete but clip ' + id + ' is still present (clip selection likely did not take — multitrack clip selection is mouse-gesture driven). Consider deleting it via the UI.');
				return { removed: id, tracks: mtTracks () };
			}
		},

		listVerbs: {
			help: 'List every supported verb with a one-line help string.',
			run: function () {
				var out = [];
				for (var v in VERBS) {
					if (!VERBS.hasOwnProperty (v)) continue;
					out.push ({ verb: v, help: VERBS[v].help });
				}
				return out;
			}
		}
	};

	// ---- command handling --------------------------------------------------

	function handleCommand ( msg ) {
		var reqId = msg.reqId;
		var verb  = msg.verb;
		var args  = msg.args || {};

		var entry = VERBS[verb];
		if (!entry) {
			return reply (reqId, false, null, 'unknown verb: ' + verb);
		}

		try {
			var data = entry.run (args);
			// Async verbs (e.g. loadAudio, export) return { __async: Promise }.
			if (data && data.__async && typeof data.__async.then === 'function') {
				data.__async.then (function ( res ) {
					reply (reqId, true, res === undefined ? null : res, null);
				}, function ( err ) {
					reply (reqId, false, null, (err && err.message) ? err.message : String (err));
				});
				return;
			}
			reply (reqId, true, data === undefined ? null : data, null);
		} catch ( err ) {
			reply (reqId, false, null, (err && err.message) ? err.message : String (err));
		}
	}

	function reply ( reqId, ok, data, error ) {
		var out = { type: 'result', reqId: reqId, ok: ok };
		if (ok) out.data = data;
		else out.error = error;
		send (out);
	}

	function send ( obj ) {
		if (!ws || ws.readyState !== 1 /* OPEN */) return false;
		try { ws.send (JSON.stringify (obj)); return true; }
		catch ( _ ) { return false; }
	}

	// ---- Did* event forwarding ---------------------------------------------
	// Curated notifications pushed to the bridge as {type:'event', name, data}.
	// We attach these once, when the editor is ready; they fire regardless of
	// whether the socket is currently open (send() no-ops when disconnected).

	var forwardedEventsWired = false;

	function wireForwardedEvents () {
		if (forwardedEventsWired || !app || !app.listenFor) return;
		forwardedEventsWired = true;

		function fwd ( name, mapper ) {
			app.listenFor (name, function ( a, b ) {
				var data;
				try { data = mapper ? mapper (a, b) : (a === undefined ? null : a); }
				catch ( _ ) { data = null; }
				send ({ type: 'event', name: name, data: data });
			});
		}

		// DidStateChange — undo/redo stack changed. state.js fires it as
		// (undo_state_list, redo_state_list), arrays of state objects that each
		// carry a live AudioBuffer in .data — far too heavy to serialize. Forward
		// only the depths and the top-of-stack descriptions.
		fwd ('DidStateChange', function ( undoList, redoList ) {
			function descs ( list ) {
				if (!list || !list.length) return [];
				return list.slice (-5).map (function ( s ) { return s && s.desc; });
			}
			return {
				canUndo:    !!(undoList && undoList.length),
				canRedo:    !!(redoList && redoList.length),
				undoDepth:  undoList ? undoList.length : 0,
				redoDepth:  redoList ? redoList.length : 0,
				recentUndo: descs (undoList),
				recentRedo: descs (redoList)
			};
		});

		// DidSelectClip — a multitrack clip became selected. Forward a lightweight
		// summary (the raw clip is a heavy live object with buffers).
		fwd ('DidSelectClip', function ( clip ) {
			if (!clip) return null;
			return {
				id:    clip.id,
				name:  clip.name,
				start: clip.start,
				track: clip.track
			};
		});

		// DidUpdateMultitrack — multitrack model changed (tracks/clips). Pair it
		// with a fresh project snapshot so controllers can react without polling.
		fwd ('DidUpdateMultitrack', function () {
			return {
				multitrack: multitrackOn (),
				duration:   duration (),
				playhead:   playhead (),
				selection:  selection ()
			};
		});

		// DidStopPlay — playback paused/stopped.
		fwd ('DidStopPlay', function () {
			return { playing: false, playhead: playhead () };
		});

		// DidZoom — waveform zoom changed. engine.js fires it as
		// [ZoomFactor, leftPercent, verticalZoom]; multitrack fires a similar array.
		fwd ('DidZoom', function ( arr ) {
			if (!arr || !arr.length) return null;
			return { zoomFactor: arr[0], leftPercent: arr[1], verticalZoom: arr[2] };
		});
	}

	// ---- websocket connect / reconnect -------------------------------------

	function connect () {
		try {
			ws = new WebSocket (BRIDGE_URL);
		} catch ( e ) {
			scheduleReconnect ();
			return;
		}

		ws.onopen = function () {
			connected = true;
			log ('connected to bridge; registering as editor');
			send ({ type: 'register', role: 'editor', name: 'audiomass' });
		};

		ws.onmessage = function ( ev ) {
			var msg;
			try { msg = JSON.parse (ev.data); }
			catch ( _ ) { return; }

			if (msg.type === 'command') {
				handleCommand (msg);
				return;
			}
			// 'registered' / bridge events: nothing required of us.
		};

		ws.onclose = function () {
			if (connected) log ('bridge connection closed; will reconnect');
			connected = false;
			ws = null;
			scheduleReconnect ();
		};

		ws.onerror = function () {
			// onclose fires after onerror; reconnect is handled there. Closing
			// here avoids a lingering half-open socket on some browsers.
			try { ws && ws.close (); } catch ( _ ) {}
		};
	}

	var reconnectTimer = null;
	function scheduleReconnect () {
		if (reconnectTimer) return;
		reconnectTimer = setTimeout (function () {
			reconnectTimer = null;
			connect ();
		}, RECONNECT_MS);
	}

	// ---- boot: poll for the editor, then wire everything up ----------------

	function boot () {
		if (!w.PKAudioEditor) {
			setTimeout (boot, POLL_MS);
			return;
		}
		app = w.PKAudioEditor;
		log ('PKAudioEditor found; wiring control client');
		wireForwardedEvents ();
		connect ();
	}

	boot ();

})( window, document );
