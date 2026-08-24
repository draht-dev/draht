# draht uni waitlist — Google Contacts backend

No ESP. Signups from `draht.dev/uni` double-opt-in via a confirmation mail,
then land in Google Contacts under the label **draht uni waitlist**. The
newsletter goes out from plain Gmail addressed to that label.

## Setup (about 10 minutes)

1. Log in to the Google account that will own the Contacts list and send the
   email. Open [script.new](https://script.new), then paste `Code.gs`.
2. In the left sidebar, select **Services → +**, then add **People API**. Its
   identifier must be `People`.
3. Select **Deploy → New deployment → Web app**. Set *Execute as* to *Me*
   and *Who has access* to *Anyone*. Authorize the contacts and mail scopes.
4. Copy the `…/exec` URL and paste it into `WAITLIST_ENDPOINT` in
   `src/pages/uni.astro`.
5. Test end to end: submit your own address on `/uni`, open the link in the
   confirmation mail, press **Confirm subscription** (the extra click exists
   so inbox link-scanners can't auto-confirm), check the contact shows up in
   the group.

## Sending an episode

Gmail → Compose → put **draht uni waitlist** in **BCC** (Gmail expands the
contact label to all members).

When someone replies "unsubscribe," complete both DSGVO erasure steps:

1. Delete the contact from the group.
2. Delete the `confirmed:<their email>` key under **Project Settings → Script
   Properties**.

The second step lets the address subscribe again and completes the Art. 17
deletion.

## Notes

- Consumer Gmail sends about 100 emails per day; Workspace sends about 1,500.
  Send in batches if the list exceeds that limit.
- After editing `Code.gs`, redeploy: **Deploy → Manage deployments → ✎ →
  Version: New**. The `/exec` URL stays the same.
- Each contact's notes field stores the double-opt-in timestamp for the DSGVO
  record.
- Confirm links expire after 48h; unconfirmed signups purge themselves.
- The abuse guard allows at most `DAILY_SEND_CAP` (30) confirmation emails per
  day and one per address every 10 minutes. Raise the cap in `Code.gs` if a
  launch reaches it.
