// Automated reminder mailer for the Above & Beyond ABA events.
// Triggered by Vercel Cron (daily). It only actually sends when:
//   1. the caller is authorized (CRON_SECRET), AND
//   2. RESEND_API_KEY is set, AND
//   3. REMINDERS_LIVE === "1"  (the master "go live" switch), AND
//   4. today matches a reminder day for that event (date gate).
// Otherwise it runs in PREVIEW mode: it reports who it *would* email and sends nothing.
//
// Required env vars: EVENTBRITE_TOKEN, CRON_SECRET, RESEND_API_KEY,
//   EVENT_WRTS_DATE (YYYY-MM-DD), REMINDERS_LIVE.
// Optional: REMINDER_OFFSETS (default "2,0" = 2 days before + day-of),
//   REMINDER_FROM (default "Above & Beyond ABA <reminders@abtaba.com>").

import { getEvents } from "./attendees.js";

const OFFSETS = (process.env.REMINDER_OFFSETS || "2,0").split(",").map(n => parseInt(n, 10)).filter(n => !isNaN(n));
const FROM = process.env.REMINDER_FROM || "Above & Beyond ABA <reminders@abtaba.com>";
const EVENT_DATE = { wrts: process.env.EVENT_WRTS_DATE };

function authorized(req){
  const secret = process.env.CRON_SECRET;
  if(!secret) return false;
  const auth = req.headers["authorization"] || "";
  const q = (req.query && (req.query.key || req.query.secret)) || "";
  return auth === `Bearer ${secret}` || q === secret;
}
function todayISO(){
  return new Intl.DateTimeFormat("en-CA", {timeZone:"America/New_York", year:"numeric", month:"2-digit", day:"2-digit"}).format(new Date());
}
function daysUntil(dateISO){
  if(!dateISO) return null;
  return Math.round((Date.parse(dateISO+"T00:00:00Z") - Date.parse(todayISO()+"T00:00:00Z")) / 86400000);
}
function esc(s){ return String(s||"").replace(/[&<>"]/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[c])); }

export default async function handler(req, res){
  if(!authorized(req)) return res.status(401).json({error:"unauthorized"});
  const token = process.env.EVENTBRITE_TOKEN;
  if(!token) return res.status(400).json({error:"No EVENTBRITE_TOKEN set"});

  const q = req.query || {};
  const which = (q.event || "wrts").toLowerCase();          // wrts | all
  const audience = (q.audience || "pending").toLowerCase(); // pending | all
  const force = q.force === "1" || q.force === "true";       // bypass the date gate (manual testing)
  const apiKey = process.env.RESEND_API_KEY;
  const liveEnabled = process.env.REMINDERS_LIVE === "1";

  let out;
  try { ({out} = await getEvents(token)); }
  catch(e){ return res.status(502).json({error:String(e && e.message || e)}); }

  const wanted = out.events.filter(e => which === "all" ? true : e.key === which);

  // Per-event date gate: only a reminder day (e.g. 2 days before / day-of) passes.
  const gated = wanted.map(e => {
    const d = daysUntil(EVENT_DATE[e.key]);
    const dueToday = force || (d !== null && OFFSETS.includes(d));
    return { event:e, daysUntil:d, dueToday };
  });

  // Gather recipients from events that are due today.
  const seen = new Set();
  const recipients = [];
  for(const g of gated){
    if(!g.dueToday) continue;
    for(const f of g.event.families){
      if(audience === "pending" && f.confirmed) continue;
      const email = (f.email||"").trim();
      const key = email.toLowerCase();
      if(!email || seen.has(key)) continue;
      seen.add(key);
      recipients.push({ email, name:f.purchaser||"", event:g.event.name });
    }
  }

  const willSend = liveEnabled && !!apiKey && recipients.length > 0;

  // PREVIEW: report only, send nothing.
  if(!willSend){
    const reasons = [];
    if(!apiKey) reasons.push("RESEND_API_KEY not set");
    if(!liveEnabled) reasons.push("REMINDERS_LIVE not '1' (still in preview)");
    if(recipients.length === 0) reasons.push("no recipients due today");
    return res.status(200).json({
      mode:"preview", today:todayISO(), event:which, audience,
      schedule: gated.map(g => ({event:g.event.key, date:EVENT_DATE[g.event.key]||null, daysUntil:g.daysUntil, dueToday:g.dueToday})),
      wouldSend: recipients.length, reasons,
      recipients: recipients.map(r => r.email)
    });
  }

  // LIVE: one personalized email per family via Resend.
  const results = { sent:0, failed:0, errors:[] };
  for(const r of recipients){
    const first = r.name ? r.name.trim().split(/\s+/)[0] : "there";
    const subject = `Reminder — ${r.event} event with Above & Beyond ABA`;
    const html =
      `<p>Hi ${esc(first)},</p>`+
      `<p>This is a friendly reminder about our upcoming <strong>${esc(r.event)}</strong> event with Above &amp; Beyond ABA. `+
      `We can’t wait to see you and your family there!</p>`+
      `<p>Warm regards,<br>The Above &amp; Beyond ABA Team</p>`;
    try{
      const resp = await fetch("https://api.resend.com/emails", {
        method:"POST",
        headers:{ "Authorization":`Bearer ${apiKey}`, "Content-Type":"application/json" },
        body: JSON.stringify({ from:FROM, to:[r.email], subject, html })
      });
      if(resp.ok) results.sent++;
      else { results.failed++; if(results.errors.length < 5) results.errors.push(`${r.email}: HTTP ${resp.status}`); }
    }catch(err){ results.failed++; if(results.errors.length < 5) results.errors.push(`${r.email}: ${String(err && err.message || err)}`); }
  }
  return res.status(200).json({ mode:"sent", today:todayISO(), event:which, audience, ...results });
}
