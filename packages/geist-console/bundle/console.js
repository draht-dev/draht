/**
 * The one daemon-served surface — behaviour (R32-FLEET.10, R33-REACH.3/.5/.9).
 * Decision record: .planning/specs/2026-08-19-geist-served-surface-decision.md
 *
 * Lists the live attachable draht sessions, opens one, streams its output and
 * sends prompts. Plain ES modules: the daemon serves this file byte for byte and
 * the browser runs it, so the file the acceptance drives is the file that ships.
 *
 * Three things here are load-bearing and deliberately not obvious:
 *
 *  1. **Authentication is a frame, not a header and never a query string.**
 *     The page opens `/attach` with no credential at all — no `Authorization`
 *     (a browser's `new WebSocket()` takes no headers), no
 *     `Sec-WebSocket-Protocol` smuggling, no `?token=`. After `hello` /
 *     `server_hello` it presents exactly one of two frames: `pair_device`,
 *     carrying the single-use bootstrap token it read out of the URL
 *     *fragment* (never sent to the server, never logged, never in a Referer),
 *     or `authenticate`, carrying the device credential it was last issued.
 *     The daemon answers both with one `device_credential` frame.
 *
 *  2. **The credential is rotated at every exchange, and persisted before the
 *     old one can be used again.** `device_credential` is written to
 *     localStorage under {@link DEVICE_KEY} — localStorage, not
 *     sessionStorage, because R33-REACH.9 asks the credential to survive a tab
 *     close and an app restart — synchronously, in the handler, overwriting the
 *     value it supersedes. The predecessor is dead the instant that frame is
 *     sent, so a write that happened "later" would be a window in which this
 *     page holds only a credential the daemon has already retired.
 *
 *     Eviction is defined rather than left to chance: a `not_authenticated`
 *     `protocol_error` clears the stored credential, stops the reconnect loop
 *     and reveals the re-bootstrap prompt. Re-pair, never a broken page.
 *
 *  3. **No protocol literal is written down twice.** The family and 0.x member
 *     come from `/ui/protocol.json`, which the daemon renders from the same
 *     `@draht/geist-protocol` constants it validates with — so a version bump
 *     cannot leave the served page speaking last month's handshake.
 *
 *  4. **A reconnect restores; it never replays.** There is no server-side
 *     scrollback to replay from — see {@link clearTranscript} — so the page
 *     keeps the transcript it has rendered across the gap, says "disconnected"
 *     while the gap lasts, and re-attaches the same session on the far side.
 *     Its retry budget is replenished by arriving, which for a connection that
 *     wanted a session means the attach and for one that did not means the
 *     exchange; the ceiling itself never moves.
 *
 *  5. **The composer is positioned against the *visual* viewport, not `dvh`.**
 *     See {@link syncViewport}: `dvh` is the layout viewport, which iOS
 *     Safari does not shrink for a keyboard, so `dvh` alone puts the
 *     composer behind one on half the browsers this phase has to serve.
 *
 * There is no HTTP fleet read here either. The fleet is session data: the
 * daemon withholds it until this connection is somebody and then pushes it on
 * the wire, so "refresh" means "reconnect", not "GET /fleet with a bearer".
 */

/** Where the rotated device credential lives, as `{deviceId, credential}`. */
const DEVICE_KEY = "geist.console.device";
const CLIENT_NAME = "geist-console";
/** Stable for the lifetime of this page; the wire wants a non-empty id. */
const CLIENT_ID = `${CLIENT_NAME}-${Math.random().toString(36).slice(2, 10)}`;
/** Reconnect attempts spent before the page stops and says so. */
const MAX_RETRIES = 8;
/** How often the diagnostics readout re-renders its live measurements. */
const DIAGNOSTICS_TICK_MS = 500;
/**
 * Slack before a shorter visual viewport counts as a keyboard, in CSS px.
 *
 * A collapsing URL bar moves the visual viewport by a pixel or two on its
 * own, and treating that as a keyboard would flicker the footer.
 */
const KEYBOARD_SLACK_PX = 8;

const el = (id) => document.getElementById(id);
const statusEl = el("status");
const fleetEl = el("fleet");
const fleetEmptyEl = el("fleet-empty");
const tokenForm = el("token-form");
const tokenInput = el("token-input");
const transcriptEl = el("transcript");
const transcriptEmptyEl = el("transcript-empty");
const sessionCwdEl = el("session-cwd");
const sessionMetaEl = el("session-meta");
const promptEl = el("prompt");

/**
 * How this device names itself in `geist devices list|revoke` (R33-REACH.6).
 * Display metadata only — the daemon assigns the device id and never trusts a
 * word of this for authorization.
 */
const DEVICE = {
	name: "geist console",
	platform: navigator.userAgentData?.platform || navigator.platform || "browser",
};

/**
 * Whether this page was asked for the evidence readout (R33-REACH.2).
 *
 * Read from the same fragment the bootstrap token arrives in, and read as a
 * *flag*: `#diag`, `#diag=1` and `#token=…&diag=1` all mean yes.
 * {@link takeBootstrapToken} strips only the token, so the flag survives into
 * the address bar and a reload keeps the readout on — which matters when the
 * thing being archived is a reconnect.
 */
const DIAGNOSTICS = new URLSearchParams(location.hash.replace(/^#/, "")).has("diag");

/** The single-use bootstrap token, if this page was opened from a pairing link. */
let bootstrap = takeBootstrapToken();
/** `{deviceId, credential}` once this browser has paired, else null. */
let device = loadDevice();
let protocol = null;
let socket = null;
/** True once a `device_credential` proved this connection to the daemon. */
let authenticated = false;
let attachedId = null;
/** The session the operator asked for, attached once this connection is authenticated. */
let wantedId = null;
/**
 * The session whose conversation is on screen, or null.
 *
 * Tracked separately from {@link attachedId} — which a drop clears — because it
 * is what decides when the transcript may be thrown away, and a drop must not
 * be able to decide that. See {@link clearTranscript}.
 */
let transcriptId = null;
/** The streaming assistant bubble; nulled whenever a new turn starts. */
let agentEntry = null;
/**
 * Permission asks on screen, keyed by `requestId` (R34-PERM.1/.2).
 *
 * Keyed rather than appended because the session REPLAYS every still-pending ask
 * to a client that (re)attaches — `PermissionDelivery.forgetClient` deliberately
 * forgets what a dead connection was shown, since a reconnecting phone has
 * nothing on its screen. This page's transcript survives a reconnect, so it
 * does, and a second `permission_request` for an id already drawn has to update
 * that element rather than stack a second Approve button under the first.
 */
const permissionAsks = new Map();
/** True while a close is one we asked for, so it reconnects instead of retrying. */
let deliberateClose = false;
let retries = 0;
/** `performance.now()` when the live socket opened, or null while there is none. */
let socketOpenedAt = null;
/** How the last socket died, as the readout prints it; empty until one has. */
let lastClose = "";

/* ------------------------------------------------------------ credential -- */

/**
 * Take the bootstrap token out of the fragment and out of the address bar.
 *
 * A fragment is the one part of a URL the browser keeps to itself, which is why
 * `geist pair`'s QR and deep link carry the token here and not in a query
 * (R33-REACH.3/.4). Deliberately *not* persisted: the token is single-use and
 * is dead the moment the daemon answers, so the only thing storing it could
 * achieve is keeping a spent secret on disk.
 */
function takeBootstrapToken() {
	const fragment = new URLSearchParams(location.hash.replace(/^#/, ""));
	const supplied = fragment.get("token");
	if (!supplied) return "";
	fragment.delete("token");
	const rest = fragment.toString();
	history.replaceState(null, "", location.pathname + (rest ? `#${rest}` : ""));
	return supplied;
}

/** The stored device credential, or null — a value that is not the documented shape is evicted rather than presented. */
function loadDevice() {
	const raw = localStorage.getItem(DEVICE_KEY);
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw);
		if (typeof parsed?.deviceId === "string" && typeof parsed?.credential === "string") {
			if (parsed.deviceId && parsed.credential) return { deviceId: parsed.deviceId, credential: parsed.credential };
		}
	} catch {
		// Fall through: unparseable is exactly as unusable as absent.
	}
	localStorage.removeItem(DEVICE_KEY);
	return null;
}

/**
 * Persist the credential the daemon just issued, replacing the one it retired.
 *
 * Synchronous and unconditional. The daemon rotates on every exchange, so the
 * value this overwrites is already refused; anything that deferred the write
 * would leave a reload holding a credential the daemon has retired, which is
 * the difference between "reconnects" and "silently unpairs itself".
 */
function rememberDevice(frame) {
	device = { deviceId: frame.deviceId, credential: frame.credential };
	localStorage.setItem(DEVICE_KEY, JSON.stringify(device));
	// Spent at the daemon in the same exchange; holding it would only invite a replay.
	bootstrap = "";
}

/** Say — in the UI — that this browser holds nothing the daemon will accept. */
function needsPairing(why) {
	tokenForm.hidden = false;
	setStatus(why, "error");
}

/**
 * Eviction (R33-REACH.9): drop the credential and ask to be paired again.
 *
 * Called only for `not_authenticated`, which is the daemon saying this exact
 * credential is not one it will take — revoked, superseded, or never issued.
 * Keeping it would spend every future reconnect re-presenting it.
 */
function forgetDevice() {
	device = null;
	bootstrap = "";
	localStorage.removeItem(DEVICE_KEY);
	needsPairing("not paired — this device's credential was refused");
}

/* ----------------------------------------------------------------- render -- */

function setStatus(text, state) {
	statusEl.textContent = text;
	statusEl.dataset.state = state;
}

function shortTime(iso) {
	const at = Date.parse(iso);
	return Number.isFinite(at) ? new Date(at).toLocaleTimeString() : iso;
}

function markCurrent() {
	for (const row of fleetEl.querySelectorAll(".session-row")) {
		if (row.dataset.sessionId === attachedId) row.setAttribute("aria-current", "true");
		else row.removeAttribute("aria-current");
	}
}

function renderFleet(sessions) {
	fleetEl.textContent = "";
	for (const session of sessions) {
		const row = document.createElement("button");
		row.type = "button";
		row.className = "session-row";
		row.dataset.sessionId = session.id;

		const cwd = document.createElement("span");
		cwd.className = "session-cwd";
		cwd.textContent = session.cwd;

		const sub = document.createElement("span");
		sub.className = "session-sub";
		sub.textContent = `pid ${session.pid} · ${shortTime(session.startedAt)} · ${session.id.slice(0, 8)}`;

		row.append(cwd, sub);
		row.addEventListener("click", () => openSession(session.id));

		const item = document.createElement("li");
		item.append(row);
		fleetEl.append(item);
	}
	fleetEmptyEl.hidden = sessions.length > 0;
	markCurrent();
}

function addEntry(kind, text) {
	transcriptEmptyEl.hidden = true;
	const entry = document.createElement("div");
	entry.className = "entry";
	entry.dataset.kind = kind;
	entry.textContent = text;
	transcriptEl.append(entry);
	transcriptEl.scrollTop = transcriptEl.scrollHeight;
	return entry;
}

/** Append streamed assistant text, opening a bubble if this is a new turn. */
function addOutput(text) {
	if (!agentEntry) agentEntry = addEntry("agent", "");
	agentEntry.textContent += text;
	transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

/**
 * Throw the conversation away. Called from exactly one place, on purpose.
 *
 * **There is no scrollback anywhere to get it back from.** The geist wire has
 * no replay frame for CONVERSATION and neither does the session's own protocol
 * (`coding-agent/src/core/socket-server/types.ts`: output, input_echo,
 * client_joined, client_left, session_metadata, error) — a session streams to
 * whoever is attached at the time and remembers nothing for whoever is not.
 * (A still-pending `permission_request` is the one exception, and it is not
 * scrollback: the agent is parked on it, so it is re-sent to a client that
 * attaches — see {@link permissionAsks}.) So
 * what this clears is the only copy, and clearing it because a socket died
 * would lose the conversation for good (R33-REACH.9). A reconnect therefore
 * preserves the transcript and re-attaches; only a deliberate switch to a
 * *different* session, where the text on screen would be the wrong session's,
 * reaches here.
 */
function clearTranscript() {
	transcriptEl.textContent = "";
	transcriptEl.append(transcriptEmptyEl);
	transcriptEmptyEl.hidden = false;
	agentEntry = null;
	// The elements those entries point at have just been thrown away; keeping the
	// index would make a replayed ask "update" a node that is no longer in the
	// document, which renders as the ask silently not arriving.
	permissionAsks.clear();
}

/* ------------------------------------------------------------ permission -- */

/**
 * One labelled fact of a permission ask.
 *
 * Two elements, both filled with `textContent`, because the value is the part an
 * attacker chose: it is the model's tool name, the model's command, the model's
 * path. It arrives ALREADY neutralized and bounded — every forbidden code point
 * replaced one for one, the middle elided with a `…[n chars elided]…` marker so
 * the decisive tail survives — and this page must not re-derive, re-sanitize or
 * re-elide any of it. Rendering it verbatim into a text node is the whole job.
 */
function permissionFact(parent, label, value) {
	const row = document.createElement("div");
	row.className = "permission-row";
	// Which typed field this row IS, kept out of the rendered text so a surface
	// test can name one without pattern-matching a label a translator may change.
	row.dataset.fact = label;

	const name = document.createElement("span");
	name.className = "permission-label";
	name.textContent = label;

	const shown = document.createElement("span");
	shown.className = "permission-value";
	shown.textContent = value;

	row.append(name, shown);
	parent.append(row);
	return row;
}

/**
 * Draw — or redraw — a permission ask (R34-PERM.1).
 *
 * **Its own element, never the assistant bubble.** `addOutput` concatenates
 * streamed text into one shared `.entry[data-kind="agent"]`, so an ask appended
 * there would inherit that bubble's direction and typography and read as
 * something the agent said. What is being approved is not narration: it gets a
 * container of its own, with its own `dir="ltr"` (console.css pairs that with
 * `unicode-bidi: isolate-override`) so no residual direction in an
 * attacker-chosen string can reorder the button labels underneath it.
 *
 * **The buttons come from `options`, never from the text.** Each is one member
 * of the frozen set the session offered, labelled with `option.label` and
 * carrying `option.id` — the only thing an answer may name. Parsing choices out
 * of a rendered sentence would let the sentence invent one.
 */
function renderPermissionRequest(frame) {
	transcriptEmptyEl.hidden = true;
	let ask = permissionAsks.get(frame.requestId);
	if (!ask) {
		const root = document.createElement("div");
		root.className = "entry permission";
		root.dataset.kind = "permission";
		root.dataset.requestId = frame.requestId;
		// An attribute, not a style: `dir` is what gives the element a base
		// direction for the CSS override to isolate against.
		root.dir = "ltr";

		const heading = document.createElement("div");
		heading.className = "permission-heading";

		const facts = document.createElement("div");
		facts.className = "permission-facts";

		const notice = document.createElement("p");
		notice.className = "permission-notice";
		notice.hidden = true;

		const options = document.createElement("div");
		options.className = "permission-options";

		const outcome = document.createElement("p");
		outcome.className = "permission-outcome";
		outcome.hidden = true;

		root.append(heading, facts, notice, options, outcome);
		transcriptEl.append(root);
		ask = { root, heading, facts, notice, options, outcome, resolved: false };
		permissionAsks.set(frame.requestId, ask);
	}

	ask.heading.textContent = frame.title;

	// Rebuilt rather than patched: a replay carries the same frame the first
	// delivery did, so "update in place" is the same rows written again.
	ask.facts.textContent = "";
	permissionFact(ask.facts, "tool", frame.toolName);
	permissionFact(ask.facts, "cwd", frame.cwd);
	if (typeof frame.command === "string") permissionFact(ask.facts, "command", frame.command);
	if (typeof frame.path === "string") permissionFact(ask.facts, "path", frame.path);
	if (typeof frame.operation === "string") permissionFact(ask.facts, "operation", frame.operation);
	if (frame.message) permissionFact(ask.facts, "reason", frame.message);

	// Said out loud, because the decision is being made on an abbreviated string.
	// How much was dropped is not a separate field on this wire: it travels
	// INSIDE the text, as the `…[n chars elided]…` marker the producer left where
	// it cut, which is the only place it can be trusted to line up with what is
	// on screen.
	ask.notice.hidden = frame.truncated !== true;
	ask.notice.textContent =
		frame.truncated === true ? "shortened to fit — the middle was elided, the end is intact" : "";

	// An ask that has already ended offers nothing: its controls were replaced by
	// the resolution line and a replay must not put them back.
	if (!ask.resolved) {
		ask.options.textContent = "";
		ask.options.hidden = false;
		for (const option of frame.options ?? []) {
			const button = document.createElement("button");
			button.type = "button";
			button.className = "permission-option";
			button.dataset.optionId = option.id;
			button.textContent = option.label;
			button.addEventListener("click", () => answerPermission(frame.requestId, option.id));
			ask.options.append(button);
		}
	}

	transcriptEl.scrollTop = transcriptEl.scrollHeight;
	return ask;
}

/**
 * Answer an ask, then stop offering to answer it again.
 *
 * The buttons are DISABLED rather than removed: the ask is not over until the
 * session says it is — a `permission_resolved` naming another surface is a
 * perfectly ordinary reply to this tap — and taking the question off screen the
 * instant it was tapped would leave nothing to attach that answer to.
 */
function answerPermission(requestId, optionId) {
	const ask = permissionAsks.get(requestId);
	if (!ask || ask.resolved) return;
	if (!send({ type: "permission_response", clientId: CLIENT_ID, requestId, optionId })) return;
	for (const button of ask.options.querySelectorAll(".permission-option")) {
		button.disabled = true;
		if (button.dataset.optionId === optionId) button.dataset.chosen = "true";
	}
	ask.outcome.hidden = false;
	ask.outcome.textContent = "sent — waiting for the session to settle it";
}

/**
 * The resolution echo reaching a browser (R34-PERM.2).
 *
 * Whoever decided, every capable client is told — so this is what takes a dead
 * dialog down on the phone that did NOT answer, and it says which surface and
 * which client did, rather than leaving a question mark where a decision was
 * made. A resolution for an ask this page never drew is nothing to draw: there
 * is no dialog here to retire.
 */
function renderPermissionResolved(frame) {
	const ask = permissionAsks.get(frame.requestId);
	if (!ask) return;
	ask.resolved = true;
	ask.root.dataset.decision = frame.decision;
	ask.options.textContent = "";
	ask.options.hidden = true;
	ask.outcome.hidden = false;
	const chosen = frame.chosenOptionId ? ` (${frame.chosenOptionId})` : "";
	const by = frame.clientId ? ` by ${frame.clientId}` : "";
	ask.outcome.textContent = `${frame.decision}${chosen} — decided on ${frame.surface}${by}`;
	transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

/* --------------------------------------------------------------- viewport -- */

/**
 * Publish the *visual* viewport to CSS, so the composer is never behind the
 * keyboard (R33-REACH.10).
 *
 * console.css sizes `body` with `var(--viewport-height, 100dvh)` and offsets
 * it with `var(--viewport-offset, 0px)`. Those two custom properties are the
 * only thing this function writes, and it writes them from the one API that
 * measures what is actually visible.
 *
 * Why `dvh` is not enough on its own: `dvh` is the *layout* viewport. Chrome
 * on Android shrinks the layout viewport when the keyboard opens, so `dvh`
 * follows and the fallback would do. iOS Safari does not — the page stays laid
 * out at full height and only `visualViewport` shrinks, which means a composer
 * anchored to `100dvh`'s bottom edge is a few hundred pixels below the
 * keyboard: on screen as far as CSS is concerned, and unreachable in fact.
 *
 * `offsetTop` is the same story a second time. With the keyboard up iOS lets
 * the page scroll under the layout viewport's origin, so the visible area
 * moves down as well as shrinking; the offset is handed to a transform, which
 * moves the pixels without being able to make the document scrollable.
 *
 * A browser with no `visualViewport` gets neither property and therefore gets
 * the `100dvh` fallback — which is correct for it, and is why this returns
 * quietly rather than throwing.
 */
function syncViewport() {
	const visual = window.visualViewport;
	if (!visual) return;
	const root = document.documentElement.style;
	root.setProperty("--viewport-height", `${visual.height}px`);
	root.setProperty("--viewport-offset", `${visual.offsetTop}px`);

	// "A keyboard is up" is not something a browser reports; it is the layout
	// viewport having more height than the visual one can see.
	const covered = window.innerHeight - (visual.height + visual.offsetTop);
	const up = covered > KEYBOARD_SLACK_PX;
	document.body.dataset.keyboard = up ? "up" : "down";
	// The last line of the transcript is what the operator was reading, and a
	// keyboard that covers it is the same defect as one that covers the
	// composer — the scroll offset that was at the bottom no longer is.
	if (up) transcriptEl.scrollTop = transcriptEl.scrollHeight;
	renderDiagnostics();
}

/* ------------------------------------------------------------ diagnostics -- */

/**
 * The evidence readout (R33-REACH.2), re-rendered from live state.
 *
 * Everything Phase 39 has to archive about a device run and cannot get off a
 * phone any other way: which browser build loaded these bytes, what geometry
 * it laid them out in, which protocol member it spoke, how long its socket
 * survived and how that socket died. One screenshot, the whole set.
 *
 * A no-op unless {@link DIAGNOSTICS} — so it is safe to call from anywhere
 * that changes one of those facts, which is what the call sites do.
 */
function renderDiagnostics() {
	if (!DIAGNOSTICS) return;
	el("diag-ua").textContent = navigator.userAgent;
	el("diag-protocol").textContent = protocol ? `${protocol.protocol}/${protocol.version}` : "—";

	const visual = window.visualViewport;
	const layout = `${window.innerWidth}x${window.innerHeight} layout`;
	const seen = visual
		? `${Math.round(visual.width)}x${Math.round(visual.height)}+${Math.round(visual.offsetTop)} visual`
		: "no visualViewport";
	el("diag-viewport").textContent = `${layout} · ${seen} · dpr ${window.devicePixelRatio}`;

	// Uptime rather than an opened-at timestamp: the measured number
	// R33-REACH.2 asks for is how long a socket lasts through the proxy before
	// something idles it out, and that is what a photograph of this line says.
	const uptimeMs = socketOpenedAt === null ? null : performance.now() - socketOpenedAt;
	el("diag-uptime").textContent = uptimeMs === null ? "—" : `${(uptimeMs / 1000).toFixed(1)}s`;
	el("diag-close").textContent = lastClose || "—";
}

/** Reveal the readout and start its clock, if this page was asked for it. */
function startDiagnostics() {
	if (!DIAGNOSTICS) return;
	el("diagnostics").hidden = false;
	renderDiagnostics();
	setInterval(renderDiagnostics, DIAGNOSTICS_TICK_MS);
}

/* ------------------------------------------------------------------- wire -- */

function send(frame) {
	if (socket?.readyState !== WebSocket.OPEN) return false;
	socket.send(JSON.stringify(frame));
	return true;
}

function sendAttach(sessionId) {
	send({ type: "attach", sessionId, clientId: CLIENT_ID, mode: "read-write" });
}

/**
 * The first frame after the handshake, and the only two shapes it takes.
 *
 * `pair_device` when this browser holds a bootstrap token it has not spent;
 * `authenticate` when it holds a credential from a previous exchange. Bootstrap
 * wins when both exist — an operator who has just scanned a fresh QR is asking
 * for a new pairing, not for the old credential to be tried first.
 */
function presentCredential() {
	if (bootstrap) {
		send({ type: "pair_device", bootstrapToken: bootstrap, device: DEVICE });
		return;
	}
	if (device) send({ type: "authenticate", deviceId: device.deviceId, credential: device.credential });
}

function connect() {
	// Nothing to present is not a connection worth opening: the daemon would
	// greet it and then refuse everything after, which costs a socket and
	// teaches the operator nothing.
	if (!protocol || (!bootstrap && !device)) return;
	authenticated = false;
	attachedId = null;
	setStatus("connecting…", "connecting");

	const url = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/attach`;
	let opened;
	try {
		// No subprotocol, no header, no query: the credential is a frame.
		opened = new WebSocket(url);
	} catch (error) {
		setStatus(`cannot connect: ${error.message}`, "error");
		return;
	}
	socket = opened;

	opened.addEventListener("open", () => {
		socketOpenedAt = performance.now();
		renderDiagnostics();
		send({
			type: "hello",
			protocol: protocol.protocol,
			version: protocol.version,
			client: { name: CLIENT_NAME, version: protocol.version },
		});
	});

	opened.addEventListener("message", (event) => {
		let frame;
		try {
			frame = JSON.parse(event.data);
		} catch {
			return;
		}
		receive(frame);
	});

	opened.addEventListener("close", (event) => {
		if (socket !== opened) return;
		socket = null;
		closed(event);
	});
}

function closed(event) {
	authenticated = false;
	attachedId = null;
	markCurrent();
	// Recorded before any of the branches below return: how the socket died is
	// the fact the archived run is after, and every one of those paths is a way
	// of dying (R33-REACH.2).
	socketOpenedAt = null;
	lastClose = `${event.code}${event.reason ? ` ${event.reason}` : ""}`;
	renderDiagnostics();

	// Evicted — or never paired. Checked before the deliberate-close branch,
	// because a credential the daemon has refused makes every reconnect a
	// refusal, including one we asked for ourselves.
	if (!bootstrap && !device) {
		deliberateClose = false;
		needsPairing("not paired — open the link from `geist pair`");
		return;
	}
	if (deliberateClose) {
		deliberateClose = false;
		connect();
		return;
	}
	// Bounded, because a rejected credential — or a session that is gone —
	// closes on every attempt and an unbounded retry would turn that into a
	// login-attempt loop. Giving up says so rather than leaving a "disconnected"
	// that is indistinguishable from one more backoff.
	if (retries >= MAX_RETRIES) {
		setStatus("disconnected — reload to reconnect", "error");
		return;
	}
	const delay = Math.min(500 * 2 ** retries, 5000);
	retries += 1;
	// Said out loud, and said as a state (R33-REACH.9): the transcript stays on
	// screen through the gap, so without this the page is indistinguishable from
	// one whose session has simply gone quiet.
	setStatus(`disconnected (${event.code}${event.reason ? ` ${event.reason}` : ""}) — reconnecting…`, "disconnected");
	setTimeout(connect, delay);
}

function receive(frame) {
	switch (frame.type) {
		// The transport handshake only proves the daemon answered — this
		// connection is still anonymous, and the daemon has deliberately sent no
		// fleet. Present the credential and wait.
		case "server_hello":
			setStatus("authenticating…", "connecting");
			presentCredential();
			break;

		// The exchange succeeded and the credential has been rotated. Persist it
		// first — before the attach, before the status, before anything that
		// could throw — because everything else on this page can be redone by
		// reloading and this cannot.
		case "device_credential":
			rememberDevice(frame);
			authenticated = true;
			tokenForm.hidden = true;
			setStatus("connected", "connected");
			// A connection that owes an attach is not finished arriving, so its
			// budget is not yet earned — see `session_metadata`. One that owes
			// nothing has arrived: it is authenticated, it is about to be handed
			// the fleet, and that is the whole of what it asked for. Replenishing
			// here is what a console left sitting on the fleet needs; without it
			// the budget was spent once across the page's entire life and the
			// eighth blip — a lock screen, a lift, a tailnet re-key — stopped it
			// reconnecting for good, on a healthy network.
			if (wantedId) sendAttach(wantedId);
			else retries = 0;
			break;

		// Session data, and the daemon's proof that it accepted us: it is not
		// sent to a connection that has not authenticated.
		case "fleet":
			renderFleet(frame.sessions);
			break;

		// The attach worked, which is the whole of what a connection that wanted a
		// session was for — so this is where *it* earns a fresh retry budget. The
		// handshake never does, and the exchange only does for a connection that
		// wanted nothing more (see `device_credential`). That split is the bound:
		// a page whose session has died authenticates successfully on every single
		// attempt and is refused only afterwards, so a budget cleared by the
		// exchange alone would never reach its ceiling and the page would hammer
		// the daemon forever.
		case "session_metadata":
			retries = 0;
			attachedId = frame.sessionId;
			wantedId = frame.sessionId;
			sessionCwdEl.textContent = frame.cwd;
			sessionMetaEl.textContent = `${frame.sessionId} · started ${shortTime(frame.createdAt)}`;
			document.body.dataset.view = "session";
			markCurrent();
			break;

		case "output":
			addOutput(frame.data);
			break;

		// Another client typed. The session excludes the sender from its echo, so
		// this is never our own prompt coming back.
		case "input_echo":
			agentEntry = null;
			addEntry("peer", frame.data);
			break;

		// A decision the agent is parked on, waiting for a human (R34-PERM.1).
		// `agentEntry` is dropped first so whatever the agent streams AFTER the ask
		// opens a new bubble instead of continuing the one the ask interrupted.
		case "permission_request":
			agentEntry = null;
			renderPermissionRequest(frame);
			break;

		// How that ask ended, wherever it was answered (R34-PERM.2).
		case "permission_resolved":
			renderPermissionResolved(frame);
			break;

		case "client_joined":
			addEntry("notice", `${frame.clientId} joined (${frame.mode})`);
			break;

		case "client_left":
			addEntry("notice", `${frame.clientId} left`);
			break;

		// Raised by the draht session — a queued prompt, a read-only refusal, an
		// ended session. `code` is what a renderer switches on; PROMPT_QUEUED is
		// the concurrent-writer notice (R32-FLEET.7) and is not a failure.
		case "error":
			addEntry(frame.code === "PROMPT_QUEUED" ? "notice" : "fatal", frame.code ? `${frame.code}: ${frame.message}` : frame.message);
			break;

		// Raised by the daemon about this connection; it is about to be dropped.
		// `not_authenticated` is the one that changes stored state: it is the
		// daemon refusing this credential, so the credential goes.
		case "protocol_error":
			addEntry("fatal", `${frame.code}: ${frame.message}`);
			setStatus(`refused: ${frame.code}`, "error");
			if (frame.code === "not_authenticated") forgetDevice();
			break;
	}
}

/* ------------------------------------------------------------- operations -- */

/**
 * One WebSocket is one attach — the bridge refuses a second `attach` on the same
 * connection — so switching sessions means leaving and coming back on a fresh
 * socket rather than pretending the wire allows something it does not.
 */
function openSession(sessionId) {
	if (attachedId === sessionId) {
		document.body.dataset.view = "session";
		return;
	}
	// The switch, and the only one: a different session's output would otherwise
	// stream into the conversation on screen. Re-opening the session already
	// rendered — after a trip back to the fleet, or while a reconnect is still in
	// flight and `attachedId` is momentarily null — keeps what is there.
	if (transcriptId !== sessionId) {
		clearTranscript();
		transcriptId = sessionId;
	}
	wantedId = sessionId;
	if (attachedId) {
		deliberateClose = true;
		send({ type: "detach", clientId: CLIENT_ID });
		attachedId = null;
	} else if (authenticated) {
		sendAttach(sessionId);
	} else if (!socket) {
		connect();
	}
}

function backToFleet() {
	document.body.dataset.view = "fleet";
	if (attachedId) {
		deliberateClose = true;
		send({ type: "detach", clientId: CLIENT_ID });
		attachedId = null;
	}
	wantedId = null;
	markCurrent();
}

function sendPrompt() {
	const text = promptEl.value;
	if (!text.trim() || !attachedId) return;
	if (!send({ type: "input", data: text, clientId: CLIENT_ID })) return;
	agentEntry = null;
	addEntry("you", text);
	promptEl.value = "";
	resizePrompt();
}

/**
 * Re-read the fleet — which, on this wire, means reconnecting.
 *
 * There is no client frame that asks for the fleet: the daemon pushes it once,
 * to a connection that has authenticated, because it is session data. So the
 * honest refresh is a fresh authenticated connection, not a bearer-authorized
 * `GET /fleet` that would put the credential back into an HTTP header.
 */
function refreshFleet() {
	if (!socket) {
		retries = 0;
		connect();
		return;
	}
	deliberateClose = true;
	socket.close();
}

function resizePrompt() {
	promptEl.style.height = "auto";
	promptEl.style.height = `${promptEl.scrollHeight}px`;
}

/* ------------------------------------------------------------------- boot -- */

function wire() {
	// Before anything can be typed into: the composer has to be on screen for
	// the first tap, not after it.
	syncViewport();
	startDiagnostics();
	if (window.visualViewport) {
		window.visualViewport.addEventListener("resize", syncViewport);
		window.visualViewport.addEventListener("scroll", syncViewport);
	}
	// Rotation, a resized desktop window, and — on browsers with no
	// `visualViewport` — the only signal there is.
	window.addEventListener("resize", syncViewport);

	el("refresh").addEventListener("click", refreshFleet);
	el("back").addEventListener("click", backToFleet);
	el("composer").addEventListener("submit", (event) => {
		event.preventDefault();
		sendPrompt();
	});
	promptEl.addEventListener("input", resizePrompt);
	promptEl.addEventListener("keydown", (event) => {
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			sendPrompt();
		}
	});
	tokenForm.addEventListener("submit", (event) => {
		event.preventDefault();
		const supplied = tokenInput.value.trim();
		if (!supplied) return;
		// A pasted pairing token is the same single-use bootstrap the deep link
		// carries; the exchange that follows is byte for byte the QR's.
		bootstrap = supplied;
		tokenInput.value = "";
		tokenForm.hidden = true;
		void start();
	});
}

async function start() {
	if (!protocol) {
		const response = await fetch("/ui/protocol.json");
		protocol = await response.json();
		// The family and member are half the pinned-version evidence set, and this
		// is the first moment the page knows them.
		renderDiagnostics();
	}
	if (!bootstrap && !device) {
		tokenForm.hidden = false;
		setStatus("waiting for a pairing token", "disconnected");
		return;
	}
	tokenForm.hidden = true;
	retries = 0;
	connect();
}

wire();
void start();
