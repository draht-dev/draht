/**
 * draht uni waitlist — Google Apps Script endpoint.
 *
 * Flow: the form on draht.dev/uni POSTs an email here → we send a
 * confirmation mail (double opt-in, DSGVO) → the mailed link opens a page
 * with a confirm button (a human click, so inbox link-scanners can't
 * auto-confirm) → the button POSTs the token back → the contact is created
 * in Google Contacts under CONTACT_GROUP. Send the newsletter from Gmail
 * by addressing that contact label.
 *
 * Abuse posture: this runs as the owner against their personal Gmail, so
 * doPost is serialized behind a script lock, sends are capped per address
 * (COOLDOWN_MS) and globally (DAILY_SEND_CAP), state is only written after
 * a mail actually went out, and responses never reveal whether an address
 * is on the list. Never interpolate user input into the HTML helpers.
 *
 * Deploy steps: see README.md next to this file (~10 minutes).
 */

const CONTACT_GROUP = "draht uni waitlist";
const CONFIRM_WINDOW_MS = 48 * 60 * 60 * 1000; // confirm links live 48h
const COOLDOWN_MS = 10 * 60 * 1000; // one mail per address per 10 min
const DAILY_SEND_CAP = 30; // way above real signup rate, bounds abuse
const SITE_URL = "https://draht.dev/uni";

function doPost(e) {
	const lock = LockService.getScriptLock();
	try {
		lock.waitLock(10000);
		const confirmToken = String((e && e.parameter && e.parameter.confirm_token) || "");
		return confirmToken ? confirm_(confirmToken) : signup_(e);
	} catch (err) {
		return htmlMessage_("Something went wrong. Email oskar@draht.dev and I'll add you by hand.");
	} finally {
		try { lock.releaseLock(); } catch (_) {}
	}
}

function doGet(e) {
	const token = String((e && e.parameter && e.parameter.token) || "");
	if (!token) return htmlMessage_("draht uni waitlist endpoint. Nothing to see here.");
	if (!isUuid_(token)) return htmlMessage_("This confirmation link is invalid. Sign up again on the site.");
	// GET must not confirm: corporate mail scanners prefetch every link.
	// The actual confirmation is the button's POST below.
	return page_(
		"<p>Confirm your place on the draht uni waitlist.</p>" +
		'<form method="post" action="' + ScriptApp.getService().getUrl() + '">' +
		'<input type="hidden" name="confirm_token" value="' + token + '">' +
		'<button type="submit" style="background:#e8e2d6;color:#141311;border:0;' +
		'padding:12px 20px;font:inherit;cursor:pointer">Confirm subscription</button>' +
		"</form>"
	);
}

function signup_(e) {
	const email = String((e && e.parameter && e.parameter.email) || "").trim().toLowerCase();
	const honeypot = String((e && e.parameter && e.parameter.hp_ref) || "");
	if (honeypot) return htmlMessage_("Thanks!"); // bot filled the hidden field — pretend success
	if (email.length > 254 || /[,;<>]/.test(email) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
		return htmlMessage_("That email address doesn't look right. Go back and try again.");
	}

	const props = PropertiesService.getScriptProperties();
	purgeExpired_(props);

	// Already confirmed, in cooldown, or over the daily cap: same reply,
	// no mail — the endpoint must not act as a subscription-status oracle.
	const SENT = "Check your inbox and click the confirmation link to join.";
	if (props.getProperty("confirmed:" + email)) return htmlMessage_(SENT);
	if (Date.now() - Number(props.getProperty("cooldown:" + email) || 0) < COOLDOWN_MS) {
		return htmlMessage_(SENT);
	}
	const day = new Date().toISOString().slice(0, 10);
	const sentToday = Number(props.getProperty("sent:" + day) || 0);
	if (sentToday >= DAILY_SEND_CAP) return htmlMessage_(SENT);

	const token = Utilities.getUuid();
	const confirmUrl = ScriptApp.getService().getUrl() + "?token=" + token;
	GmailApp.sendEmail(email, "Confirm your draht uni subscription",
		"You asked to get every episode of the draht uni build in your inbox.\n\n" +
		"Confirm here: " + confirmUrl + "\n\n" +
		"The link works for 48 hours. If this wasn't you, ignore this mail and nothing happens.\n" +
		"Unsubscribe anytime by replying \"unsubscribe\".");

	// state is written only after the mail actually went out
	props.setProperty("pending:" + token, JSON.stringify({ email: email, ts: Date.now() }));
	props.setProperty("cooldown:" + email, String(Date.now()));
	props.setProperty("sent:" + day, String(sentToday + 1));
	return htmlMessage_(SENT);
}

function confirm_(token) {
	if (!isUuid_(token)) return htmlMessage_("This confirmation link is invalid. Sign up again on the site.");
	const props = PropertiesService.getScriptProperties();
	const raw = props.getProperty("pending:" + token);
	if (!raw) {
		return htmlMessage_("This confirmation link has expired or was already used. If you just confirmed, you're on the list.");
	}
	const pending = JSON.parse(raw);
	if (Date.now() - pending.ts > CONFIRM_WINDOW_MS) {
		props.deleteProperty("pending:" + token);
		return htmlMessage_("This confirmation link has expired. Sign up again on the site.");
	}
	if (!props.getProperty("confirmed:" + pending.email)) {
		addContact_(pending.email); // throws → token survives, the click can be retried
		props.setProperty("confirmed:" + pending.email, new Date().toISOString());
	}
	props.deleteProperty("pending:" + token);
	return redirect_(SITE_URL + "?confirmed=1");
}

function addContact_(email) {
	// double-opt-in timestamp goes into the contact's notes as the DSGVO paper trail
	const person = People.People.createContact({
		emailAddresses: [{ value: email }],
		biographies: [{
			value: "draht uni waitlist — double opt-in confirmed " + new Date().toISOString(),
			contentType: "TEXT_PLAIN",
		}],
	});
	People.ContactGroups.Members.modify(
		{ resourceNamesToAdd: [person.resourceName] },
		groupResourceName_()
	);
}

function groupResourceName_() {
	const props = PropertiesService.getScriptProperties();
	const cached = props.getProperty("groupResourceName");
	if (cached) return cached;
	const groups = People.ContactGroups.list({ pageSize: 200 }).contactGroups || [];
	let group = null;
	for (let i = 0; i < groups.length; i++) {
		if (groups[i].name === CONTACT_GROUP) { group = groups[i]; break; }
	}
	if (!group) group = People.ContactGroups.create({ contactGroup: { name: CONTACT_GROUP } });
	props.setProperty("groupResourceName", group.resourceName);
	return group.resourceName;
}

function purgeExpired_(props) {
	const all = props.getProperties();
	const now = Date.now();
	const today = new Date().toISOString().slice(0, 10);
	Object.keys(all).forEach(function (k) {
		try {
			if (k.indexOf("pending:") === 0 && now - JSON.parse(all[k]).ts > CONFIRM_WINDOW_MS) {
				props.deleteProperty(k);
			} else if (k.indexOf("cooldown:") === 0 && now - Number(all[k]) > COOLDOWN_MS) {
				props.deleteProperty(k);
			} else if (k.indexOf("sent:") === 0 && k !== "sent:" + today) {
				props.deleteProperty(k);
			}
		} catch (_) {
			props.deleteProperty(k);
		}
	});
}

function isUuid_(s) {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s);
}

// Only static strings and validated UUIDs are rendered — never echo user input.
function htmlMessage_(text) {
	return page_("<p>" + text + "</p>");
}

function page_(inner) {
	return HtmlService.createHtmlOutput(
		'<body style="margin:0;display:grid;place-items:center;min-height:100vh;background:#141311;color:#e8e2d6;' +
		'font:15px/1.6 ui-monospace,monospace"><div style="max-width:44ch;padding:24px;text-align:center">' +
		inner +
		'<p><a href="' + SITE_URL + '" style="color:#c47a4a">draht.dev/uni</a></p></div></body>'
	);
}

function redirect_(url) {
	return HtmlService.createHtmlOutput(
		'<meta http-equiv="refresh" content="0;url=' + url + '">' +
		'<body style="background:#141311;color:#e8e2d6;font:15px ui-monospace,monospace;padding:24px">' +
		'Confirmed. <a href="' + url + '" style="color:#c47a4a">Back to draht.dev/uni</a></body>'
	);
}
