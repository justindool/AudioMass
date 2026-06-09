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
			help: 'Return {loaded,duration,playhead,selection,multitrack} describing the current project state.',
			run: function () {
				return {
					loaded:     loaded (),
					duration:   duration (),
					playhead:   playhead (),
					selection:  selection (),
					multitrack: multitrackOn ()
				};
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
