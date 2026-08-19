/**
 * The one daemon-served surface — behaviour (R32-FLEET.10).
 * Decision record: .planning/specs/2026-08-19-geist-served-surface-decision.md
 *
 * Lists the live attachable draht sessions, opens one, streams its output and
 * sends prompts. Plain ES modules: the daemon serves this file byte for byte and
 * the browser runs it, so the file the acceptance drives is the file that ships.
 *
 * Two things here are load-bearing and deliberately not obvious:
 *
 *  1. **The credential never touches a query string.** It arrives in the URL
 *     *fragment* (never sent to the server, never logged, never in a Referer),
 *     moves to sessionStorage on the first tick and is stripped from the address
 *     bar. `GET /fleet` then uses `Authorization: Bearer`; the attach WebSocket —
 *     which takes no headers from `new WebSocket()` — carries it in the
 *     `Sec-WebSocket-Protocol` request header as `geist.bearer.<base64url>`.
 *     base64url is required, not decoration: Chromium refuses a subprotocol
 *     containing `/` or `=` (not RFC 7230 tchars) before a byte leaves the page.
 *     R33-REACH.3 deletes the daemon's `?token=` fallback; nothing here uses it.
 *
 *  2. **No protocol literal is written down twice.** The family and 0.x member
 *     come from `/ui/protocol.json`, which the daemon renders from the same
 *     `@draht/geist-protocol` constants it validates with — so a version bump
 *     cannot leave the served page speaking last month's handshake.
 */

const TOKEN_KEY = "geist.console.token";
const WS_BEARER_PREFIX = "geist.bearer.";
const CLIENT_NAME = "geist-console";
/** Stable for the lifetime of this page; the wire wants a non-empty id. */
const CLIENT_ID = `${CLIENT_NAME}-${Math.random().toString(36).slice(2, 10)}`;
/** Reconnect attempts spent before the page stops and says so. */
const MAX_RETRIES = 8;

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

let token = takeToken();
let protocol = null;
let socket = null;
let greeted = false;
let attachedId = null;
/** The session the operator asked for, attached after the next `server_hello`. */
let wantedId = null;
/** The streaming assistant bubble; nulled whenever a new turn starts. */
let agentEntry = null;
/** True while a close is one we asked for, so it reconnects instead of retrying. */
let deliberateClose = false;
let retries = 0;

/* ------------------------------------------------------------------ token -- */

/** base64url — the subprotocol alphabet a browser will actually accept. */
function base64url(text) {
	const bytes = new TextEncoder().encode(text);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Take the credential out of the fragment and out of the address bar.
 *
 * A fragment is the one part of a URL the browser keeps to itself, which is why
 * Phase 33's QR deep link will carry the bootstrap token here and not in a query.
 */
function takeToken() {
	const fragment = new URLSearchParams(location.hash.replace(/^#/, ""));
	const supplied = fragment.get("token");
	if (!supplied) return sessionStorage.getItem(TOKEN_KEY) ?? "";
	sessionStorage.setItem(TOKEN_KEY, supplied);
	fragment.delete("token");
	const rest = fragment.toString();
	history.replaceState(null, "", location.pathname + (rest ? `#${rest}` : ""));
	return supplied;
}

function forgetToken() {
	token = "";
	sessionStorage.removeItem(TOKEN_KEY);
	tokenForm.hidden = false;
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

function clearTranscript() {
	transcriptEl.textContent = "";
	transcriptEl.append(transcriptEmptyEl);
	transcriptEmptyEl.hidden = false;
	agentEntry = null;
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

function connect() {
	if (!token || !protocol) return;
	greeted = false;
	attachedId = null;
	setStatus("connecting…", "connecting");

	const url = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/attach`;
	let opened;
	try {
		opened = new WebSocket(url, [WS_BEARER_PREFIX + base64url(token)]);
	} catch (error) {
		setStatus(`cannot connect: ${error.message}`, "error");
		return;
	}
	socket = opened;

	opened.addEventListener("open", () => {
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
	greeted = false;
	attachedId = null;
	markCurrent();

	if (deliberateClose) {
		deliberateClose = false;
		connect();
		return;
	}
	setStatus(`disconnected (${event.code}${event.reason ? ` ${event.reason}` : ""})`, "disconnected");
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
	setTimeout(connect, delay);
}

function receive(frame) {
	switch (frame.type) {
		// The transport handshake only proves the daemon answered. Deliberately
		// does NOT clear `retries`: the attach that follows can still be refused
		// — `unknown_session` when the session died — and a counter reset here
		// would make every one of those refusals look like a fresh start, which
		// is an unbounded reconnect loop against a session that is never coming
		// back. Only `session_metadata` below, the daemon's answer to a
		// SUCCESSFUL attach, is evidence the retry budget can be given back.
		case "server_hello":
			greeted = true;
			setStatus(`connected · ${frame.server.name} ${frame.server.version}`, "connected");
			if (wantedId) sendAttach(wantedId);
			break;

		case "fleet":
			renderFleet(frame.sessions);
			break;

		// The attach worked. This — not the handshake — is what earns a fresh
		// retry budget, so a transient drop mid-session still reconnects freely
		// while a session that cannot be attached to runs the budget down.
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
		case "protocol_error":
			addEntry("fatal", `${frame.code}: ${frame.message}`);
			setStatus(`refused: ${frame.code}`, "error");
			if (frame.code === "not_authenticated") forgetToken();
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
	wantedId = sessionId;
	clearTranscript();
	if (attachedId) {
		deliberateClose = true;
		send({ type: "detach", clientId: CLIENT_ID });
		attachedId = null;
	} else if (greeted) {
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

async function refreshFleet() {
	if (!token) return;
	const response = await fetch("/fleet", { headers: { Authorization: `Bearer ${token}` } });
	if (response.status === 401) {
		forgetToken();
		setStatus("token rejected", "error");
		return;
	}
	if (!response.ok) return;
	const body = await response.json();
	renderFleet(body.sessions ?? []);
}

function resizePrompt() {
	promptEl.style.height = "auto";
	promptEl.style.height = `${promptEl.scrollHeight}px`;
}

/* ------------------------------------------------------------------- boot -- */

function wire() {
	el("refresh").addEventListener("click", () => {
		void refreshFleet();
	});
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
		token = supplied;
		sessionStorage.setItem(TOKEN_KEY, supplied);
		tokenInput.value = "";
		tokenForm.hidden = true;
		void start();
	});
}

async function start() {
	if (!token) {
		tokenForm.hidden = false;
		setStatus("waiting for a token", "disconnected");
		return;
	}
	tokenForm.hidden = true;
	retries = 0;
	if (!protocol) {
		const response = await fetch("/ui/protocol.json");
		protocol = await response.json();
	}
	await refreshFleet();
	connect();
}

wire();
void start();
