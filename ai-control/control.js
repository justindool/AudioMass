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
