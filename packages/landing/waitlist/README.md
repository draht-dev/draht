# draht uni waitlist — Google Contacts backend

No ESP. Signups from `draht.dev/uni` double-opt-in via a confirmation mail,
then land in Google Contacts under the label **draht uni waitlist**. The
newsletter goes out from plain Gmail addressed to that label.

## Setup (~10 min, once)

1. Open [script.new](https://script.new) **while logged into the Google
   account whose Contacts/Gmail will hold the list** and paste `Code.gs`.
2. In the left sidebar: **Services → +** → add **People API** (identifier
   must be `People`).
3. **Deploy → New deployment → Web app** — *Execute as: Me*, *Who has
   access: Anyone*. Authorize when asked (contacts + mail scopes).
4. Copy the `…/exec` URL and paste it into `WAITLIST_ENDPOINT` in
   `src/pages/uni.astro`.
5. Test end to end: submit your own address on `/uni`, open the link in the
   confirmation mail, press **Confirm subscription** (the extra click exists
   so inbox link-scanners can't auto-confirm), check the contact shows up in
   the group.

## Sending an episode

Gmail → Compose → put **draht uni waitlist** in **BCC** (Gmail expands the
contact label to all members).

**Unsubscribe / erasure (both steps, DSGVO):** when someone replies
"unsubscribe", (1) delete the contact from the group, **and** (2) delete the
`confirmed:<their email>` key in the script's **Project Settings → Script
Properties**. Step 2 is what lets them re-subscribe later and completes an
Art.-17 deletion.

## Notes

- Consumer Gmail sends ~100 mails/day, Workspace ~1,500 — fine at waitlist
  scale; batch send if the list outgrows it.
- After editing `Code.gs`, redeploy: **Deploy → Manage deployments → ✎ →
  Version: New**. The `/exec` URL stays the same.
- The double-opt-in timestamp is stored in each contact's notes field —
  that's the DSGVO paper trail.
- Confirm links expire after 48h; unconfirmed signups purge themselves.
- Abuse guard: max `DAILY_SEND_CAP` (30) confirmation mails per day, one per
  address per 10 minutes — raise the cap in `Code.gs` if a launch spike ever
  hits it.
