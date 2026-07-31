# ABT North Carolina Events — Dashboard Setup

Live attendee dashboard for the Above & Beyond ABA **"Free Event at We Rock the
Spectrum Kids Gym"** event, hosted on Vercel. It's a static page (`index.html`)
plus one serverless function (`api/attendees.js`) that securely pulls attendees
from Eventbrite, showing every registration question, per-time-slot results, and
an approve/reject workflow.

## Making the site public to everyone

If people get a **Vercel login page**, an **"Authentication Required" / 401**,
or a **password prompt** when opening the link, that is Vercel's
**Deployment Protection** — not a bug in this code. Turn it off in the
dashboard:

1. Go to <https://vercel.com> → open this project.
2. **Settings** → **Deployment Protection** (left sidebar).
3. Set **Vercel Authentication** to **Disabled / Off**.
4. Make sure **Password Protection** and **Trusted IPs** are also **off**.
5. **Save**, then redeploy (Deployments → latest → ⋯ → **Redeploy**).

Once disabled, anyone with the link can view the dashboard — no login needed.

> Deployment Protection is a Pro/Enterprise feature. On the free (Hobby) plan
> it is off by default, so the link should already be public.

## Required environment variables (Vercel → Settings → Environment Variables)

| Variable            | Required | Purpose                                                        |
| ------------------- | -------- | -------------------------------------------------------------- |
| `EVENTBRITE_TOKEN`  | Yes      | Private Eventbrite API token. Server-side only; never exposed. |
| `EVENT_WRTS`        | Optional | We Rock the Spectrum event IDs, **comma-separated** (one per time slot). Otherwise auto-discovered by name, with a built-in fallback to the known listing. |

After changing environment variables, **redeploy** for them to take effect.

### Approve / reject workflow

Every registration has **Approve** and **Reject** buttons. Registrations where
**no guest has an autism diagnosis** are also collected in a **Needs review**
section at the top of the page, and you can filter the list by
All / Needs review / Approved / Rejected.

Clicking **Reject** opens a ready-to-send email in your mail client, pre-filled
to that family, explaining the event is for the autism community — review/edit
it and hit send. (Edit the wording in `index.html`, function `rejectEmail`.)

> Decisions are saved in **your browser** (localStorage), so they persist for
> you across reloads but are not yet shared across devices or teammates. Ask if
> you'd like these moved to a shared server-side store.

### We Rock the Spectrum tab

The dashboard auto-detects the **"Free Event at We Rock the Spectrum Kids Gym"**
event on your Eventbrite (any event whose name mentions "we rock the spectrum" /
"spectrum kids gym"), and falls back to the known listing ID
(`1993615746364`) if the name ever changes. Its three times may be three
separate Eventbrite listings **or** three ticket classes on one listing — either
way the dashboard tags each registration with its time slot, so you can filter
by time and see per-slot counts.

This tab shows **every registration question and answer** dynamically (not a
fixed set of columns): a **Results by question** panel aggregates the answers,
and each registration expands to show the full Q&A per guest.

If auto-discovery ever grabs the wrong events (or misses one), open
`/api/attendees?debug=1` — the `candidates` list shows every event name + ID
your token can see. Copy the three We Rock the Spectrum IDs into `EVENT_WRTS`
(comma-separated) and redeploy to pin them exactly.

## Sending an email from the dashboard

The **✉ Compose email** button opens a panel to write a subject + message and
send it to everyone registered for the current event (one personalized email
each — `{{first}}` is replaced with the recipient's first name). It uses
[Resend](https://resend.com) and is **safe by default**: it only sends when ALL
of these are true, otherwise it just previews who it *would* email:

1. You enter the correct **passphrase** (`SEND_SECRET`).
2. `RESEND_API_KEY` is set.
3. `EMAIL_LIVE` = `1` (the master "go live" switch).
4. There is a subject, a message, and at least one recipient.

### Env vars for compose-and-send (Vercel → Settings → Environment Variables)

| Variable         | Purpose                                                          |
| ---------------- | --------------------------------------------------------------- |
| `SEND_SECRET`    | Passphrase you type in the dashboard to authorize sends. (Falls back to `CRON_SECRET` if unset.) |
| `RESEND_API_KEY` | From resend.com. Enables sending.                               |
| `EMAIL_LIVE`     | Set to `1` only when you're ready for real emails to go out.    |
| `EMAIL_FROM`     | (optional) From address. Default `events@abtaba.com`.           |

Until `EMAIL_LIVE=1`, the Send button is completely safe — it will only ever
show you the recipient list and the reason nothing was sent.

## Automated email campaign (two tracks)

A single daily Vercel Cron hits `/api/send-reminders`, which drives the whole
campaign off the event date via [Resend](https://resend.com). There are two
tracks, both from the same endpoint:

1. **Weekly nurture** — one "ABA myth vs. reality" email per week (default
   every **Wednesday**) while the event is still further out than the longest
   countdown offset. The myth rotates each week and every email includes a live
   "the event is in _X_ days" countdown.
2. **Countdown ramp** — dedicated reminders at **5, 3, 2, and 0 days** before
   the event, each with its own copy. A countdown day always wins over a weekly
   day, so nobody ever gets two emails on the same date.

It is **safe by default** — it only actually sends when ALL of these are true,
otherwise it runs in preview mode (sends nothing and just reports who/what it
would send):

1. Caller is authorized (`CRON_SECRET`)
2. `RESEND_API_KEY` is set
3. `REMINDERS_LIVE` = `1`  ← the master "go live" switch
4. Today is a scheduled send day (a weekly day or a countdown day) with recipients

Example calendar for an **Aug 21** event: weekly myths go out **Jul 29, Aug 5,
Aug 12**, then the ramp fires **Aug 16 (5-day) → Aug 18 (3-day) → Aug 19
(2-day) → Aug 21 (day-of)**.

### Env vars (Vercel → Settings → Environment Variables)

| Variable               | Purpose                                                          |
| ---------------------- | --------------------------------------------------------------- |
| `CRON_SECRET`          | Any long random string; authorizes the cron / manual calls.     |
| `RESEND_API_KEY`       | From resend.com. Enables sending.                               |
| `REMINDERS_LIVE`       | Set to `1` only when you're ready for real emails to go out.     |
| `EVENT_WRTS_DATE`      | We Rock the Spectrum event date, `YYYY-MM-DD` (e.g. `2026-08-21`). |
| `REMINDER_OFFSETS`     | (optional) countdown days-before to send. Default `5,3,2,0`.     |
| `WEEKLY_DAY`           | (optional) weekday for the weekly myth email, `0`=Sun…`6`=Sat. Default `3` (Wednesday). |
| `REMINDER_FROM`        | (optional) From address. Default `reminders@abtaba.com`.        |
| `EVENT_VENUE`          | (optional) Venue name shown in emails. Default `We Rock the Spectrum Kids Gym`. |

### Preview it before going live

Open any of these while logged in (they bypass the date gate and send nothing
until `REMINDERS_LIVE=1`):

- `/api/send-reminders?key=YOUR_CRON_SECRET&force=1` — whatever today would send.
- `/api/send-reminders?key=YOUR_CRON_SECRET&type=weekly&week=0` — force a weekly
  email using myth index `0` (bump `week` to preview each myth).
- `/api/send-reminders?key=YOUR_CRON_SECRET&type=countdown&days=5` — force the
  5-day countdown email (try `days=3`, `2`, `0` too).

Each preview shows the exact `subject`, the recipient list, and the reason
nothing was sent. When happy, set `REMINDERS_LIVE=1`.

## Local / structure notes

- `index.html` — the dashboard UI; fetches `/api/attendees`.
- `api/attendees.js` — Vercel serverless function; Eventbrite sync for the
  We Rock the Spectrum event. Returns every registration question and answer.
- `api/send-email.js` — compose-and-send endpoint (Resend), preview-safe.
- `api/send-reminders.js` — automated daily reminder cron (Resend).
- No build step is required; Vercel serves the static file and the functions
  automatically.
