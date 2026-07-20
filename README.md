# We Rock the Spectrum — Attendee Dashboard

A standalone live dashboard for the Above & Beyond ABA **"Free Event at We Rock
the Spectrum Kids Gym"** event. Pulls attendees live from Eventbrite and shows
every registration question, per-time-slot results, and an approve/reject review
workflow.

This is a **separate** site from the North Carolina (Charlotte + Cary) dashboard.

## What's here

- `index.html` — the dashboard UI.
- `api/attendees.js` — serverless function; live Eventbrite sync for the
  We Rock the Spectrum event, returning every registration question and answer.
- `api/send-email.js` — compose-and-send endpoint (Resend), preview-safe.
- `api/send-reminders.js` — optional automated reminder cron.
- `vercel.json` — cron schedule.
- `SETUP.md` — full setup, environment variables, and feature notes.

## Deploy (Vercel)

1. Create a new Vercel project and connect this repository.
2. Add the environment variable **`EVENTBRITE_TOKEN`** (your private Eventbrite
   API token). See `SETUP.md` for optional variables (`EVENT_WRTS`, email/reminders).
3. Deploy. No build step is required.

## Features

- **All questions:** every Eventbrite registration question and answer, shown
  per guest and aggregated in a "Results by question" panel.
- **Time slots:** the event's three times are detected and each registration is
  tagged and filterable by slot.
- **Needs review:** any registration where a child answered "No" to the autism
  diagnosis question is collected for approve/reject; the whole family stays on
  the card. Decisions are saved in the browser.
- **Reject → email:** rejecting opens a pre-written email to that family.
- **Compose email:** message registrants from the dashboard (Resend, preview-safe).

See `SETUP.md` for the full details.
