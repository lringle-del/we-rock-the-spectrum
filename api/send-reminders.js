// Automated email CAMPAIGN engine for the Above & Beyond ABA event.
// A single daily Vercel Cron drives two tracks off the event date:
//
//   1. WEEKLY nurture — one "ABA myth vs. reality" email per week (default
//      every Wednesday) while the event is still more than the longest
//      countdown offset away. Content rotates each week and includes a live
//      "the event is in X days" countdown.
//   2. COUNTDOWN ramp — dedicated reminders at 5, 3, 2, and 0 days before
//      (configurable). A countdown day always wins over a weekly day, so a
//      family never receives two emails on the same date.
//
// It is SAFE BY DEFAULT. It only actually sends when ALL of these are true;
// otherwise it runs in PREVIEW mode (reports who/what it would send, sends
// nothing):
//   1. the caller is authorized (CRON_SECRET), AND
//   2. RESEND_API_KEY is set, AND
//   3. REMINDERS_LIVE === "1"  (the master "go live" switch), AND
//   4. today is a scheduled send day (weekly or countdown) with recipients.
//
// Required env vars: EVENTBRITE_TOKEN, CRON_SECRET, RESEND_API_KEY,
//   REMINDERS_LIVE, EVENT_WRTS_DATE (YYYY-MM-DD).
// Optional: REMINDER_OFFSETS (default "5,3,2,0"), WEEKLY_DAY (0=Sun..6=Sat,
//   default "3" = Wednesday), WEEKLY_LIVE (default follows REMINDERS_LIVE),
//   REMINDER_FROM (default "Above & Beyond ABA <reminders@abtaba.com>"),
//   EVENT_VENUE (default "We Rock the Spectrum Kids Gym").
//
// Manual preview / testing (while logged in), bypasses the date gate:
//   /api/send-reminders?key=CRON_SECRET&force=1                → whatever today would send
//   /api/send-reminders?key=CRON_SECRET&type=weekly&week=0     → force weekly, myth index 0
//   /api/send-reminders?key=CRON_SECRET&type=countdown&days=5  → force the 5-day email

import { getEvents } from "./attendees.js";
import crypto from "crypto";

// Signed per-family confirm link (must match api/confirm.js sigFor).
function sigFor(order){
  const secret = process.env.CRON_SECRET || "";
  return crypto.createHmac("sha256", secret).update(String(order)).digest("hex").slice(0, 16);
}

// Includes 1 ("tomorrow") alongside 5/3/2/0 so every day in the final run-up has its own reminder.
const OFFSETS = (process.env.REMINDER_OFFSETS || "5,3,2,1,0")
  .split(",").map(n => parseInt(n, 10)).filter(n => !isNaN(n));
const MAX_OFFSET = OFFSETS.length ? Math.max(...OFFSETS) : 0;
const WEEKLY_DAY = (() => { const n = parseInt(process.env.WEEKLY_DAY ?? "3", 10); return isNaN(n) ? 3 : ((n % 7) + 7) % 7; })();
const FROM = process.env.REMINDER_FROM || "Above & Beyond ABA <events@updates.abtaba.com>";
const REPLY_TO = process.env.EMAIL_REPLY_TO || "lringle@abtaba.com";
const TEAM_COPY = (process.env.TEAM_COPY || "jmayerovitz@abtaba.com,koneil@abtaba.com").split(",").map(s=>s.trim()).filter(Boolean);
const VENUE = process.env.EVENT_VENUE || "We Rock the Spectrum Kids Gym";
const EVENT_DATE = { wrts: process.env.EVENT_WRTS_DATE };
const EVENT_NAME = { wrts: "Free Event at We Rock the Spectrum Kids Gym" };

// ---------- date helpers (all in America/New_York) ----------
function todayISO(){
  return new Intl.DateTimeFormat("en-CA", {timeZone:"America/New_York", year:"numeric", month:"2-digit", day:"2-digit"}).format(new Date());
}
function daysUntil(dateISO){
  if(!dateISO) return null;
  return Math.round((Date.parse(dateISO+"T00:00:00Z") - Date.parse(todayISO()+"T00:00:00Z")) / 86400000);
}
// Weekday (0=Sun..6=Sat) of today's ET calendar date.
function weekdayET(){ return new Date(todayISO()+"T12:00:00Z").getUTCDay(); }
// Deterministic, always-advancing week counter so the weekly myth rotates
// without needing any stored state.
function weekEpoch(){ return Math.floor(Date.parse(todayISO()+"T00:00:00Z") / (7*86400000)); }
function prettyDate(dateISO){
  if(!dateISO) return "";
  const d = new Date(dateISO+"T12:00:00Z");
  return new Intl.DateTimeFormat("en-US",{timeZone:"UTC",weekday:"long",month:"long",day:"numeric"}).format(d);
}
function esc(s){ return String(s||"").replace(/[&<>"]/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[c])); }
function dayWord(d){ return d === 0 ? "today" : d === 1 ? "tomorrow" : `in ${d} days`; }

// ---------- content ----------
// Weekly "myth vs. reality" series. Kept warm, brief, and neurodiversity-
// affirming. Rotates one per week.
const MYTHS = [
  {
    tag: "“ABA tries to change who my child is.”",
    reality: "Modern, compassionate ABA isn’t about making anyone “less autistic.” " +
      "It’s about building the communication and daily-living skills a child <em>wants</em> " +
      "and needs, reducing the barriers that frustrate them, and always following the child’s lead."
  },
  {
    tag: "“ABA is just rigid drills at a table.”",
    reality: "Today’s ABA is play-based and happens where life happens — on the floor, at the park, " +
      "and yes, in a sensory gym. Learning is woven into the things a child already loves to do."
  },
  {
    tag: "“ABA is one-size-fits-all.”",
    reality: "Every plan is built around one specific child — their strengths, their interests, and the " +
      "goals your family chooses together. What we do for your child is designed for <em>your</em> child."
  },
  {
    tag: "“ABA means stopping stimming.”",
    reality: "Stimming is self-regulation, and harmless self-regulation is welcome. Good ABA focuses on " +
      "safety, communication, and connection — not on making a child sit still or “look typical.”"
  },
  {
    tag: "“It’s too late — my child is past the age for ABA.”",
    reality: "There’s no cutoff. ABA supports skills and independence across ages and settings; the right " +
      "goals simply grow up alongside your child."
  }
];

function shell(inner){
  return `<div style="font-family:Inter,Segoe UI,Arial,sans-serif;font-size:16px;line-height:1.55;color:#1f2430;max-width:560px;margin:0 auto">`
    + inner
    + `<hr style="border:none;border-top:1px solid #e6e8ee;margin:26px 0 14px">`
    + `<p style="font-size:12px;color:#8a90a0;margin:0">You’re receiving this because you registered for our free event at ${esc(VENUE)}. `
    + `If you can no longer make it, just reply to this email and we’ll take you off the list.</p>`
    + `</div>`;
}
function eventLine(dateISO, slot){
  const when = prettyDate(dateISO);
  const slotTxt = slot ? ` · your time: <strong>${esc(slot)}</strong>` : "";
  return `<p style="background:#f4f6fb;border-radius:10px;padding:12px 14px;margin:18px 0">`
    + `📍 <strong>${esc(EVENT_NAME.wrts)}</strong><br>${esc(when)} · ${esc(VENUE)}${slotTxt}</p>`;
}
function confirmButton(){
  return `<div style="text-align:center;margin:18px 0 6px">`
    + `<a href="{{confirm_url}}" style="display:inline-block;background:#6b5bd6;color:#fff;text-decoration:none;font-weight:700;padding:13px 28px;border-radius:8px;font-size:15px">I confirm my spot</a></div>`;
}

// Build subject + html for a WEEKLY nurture email.
function weeklyEmail(mythIndex, days, dateISO, slot){
  const m = MYTHS[((mythIndex % MYTHS.length) + MYTHS.length) % MYTHS.length];
  const subject = `Myth vs. reality about ABA — and we’ll see you ${dayWord(days)}`;
  const html = shell(
    `<p>Hi {{first}},</p>`
    + `<p>While we count down to our free family event, we’re sharing one quick ABA myth each week — `
    + `because good information makes a real difference.</p>`
    + `<div style="border-left:3px solid #6b5bd6;padding:2px 0 2px 14px;margin:16px 0">`
    +   `<p style="margin:0 0 6px;color:#6b5bd6;font-weight:600">Myth: ${m.tag}</p>`
    +   `<p style="margin:0"><strong>Reality:</strong> ${m.reality}</p>`
    + `</div>`
    + `<p><strong>The event is ${dayWord(days)}${days>1?` — ${days} days to go!`:"!"}</strong></p>`
    + eventLine(dateISO, slot)
    + `<p>Come play, meet our team, and ask us anything. No pressure, no cost — just a fun, `
    + `sensory-friendly morning for your family.</p>`
    + `<p style="margin:16px 0 4px">Haven’t confirmed yet? Tap below so we know to expect you:</p>`
    + confirmButton()
    + `<p>Warmly,<br>The Above &amp; Beyond ABA Team</p>`
  );
  return { subject, html };
}

// Build subject + html for a COUNTDOWN reminder at a given offset.
function countdownEmail(offset, days, dateISO, slot){
  const copy = {
    5: {
      subject: `5 days to go — your family event at ${VENUE}`,
      lead: `We’re just <strong>5 days</strong> away and so excited to meet you! Here’s everything in one place so the day is easy and stress-free.`
    },
    3: {
      subject: `3 days away — a few quick details`,
      lead: `Only <strong>3 days</strong> to go! A quick note so you know what to expect when you arrive.`
    },
    2: {
      subject: `See you in 2 days!`,
      lead: `<strong>2 days</strong> to go! We can’t wait to see you and your family.`
    },
    1: {
      subject: `Tomorrow’s the day! 🎉`,
      lead: `It’s almost here — we’ll see you <strong>tomorrow</strong>!`
    },
    0: {
      subject: `Today’s the day! 🎉`,
      lead: `<strong>Today’s the day!</strong> We’re all set up and ready to welcome you.`
    }
  };
  const c = copy[offset] || {
    subject: `Reminder — your event is ${dayWord(days)}`,
    lead: `A friendly reminder that our free family event is <strong>${dayWord(days)}</strong>.`
  };
  const html = shell(
    `<p>Hi {{first}},</p>`
    + `<p>${c.lead}</p>`
    + eventLine(dateISO, slot)
    + `<ul style="margin:14px 0;padding-left:20px">`
    +   `<li>Arriving a few minutes early helps us get everyone settled.</li>`
    +   `<li>Dress comfy — there’s lots of play, climbing, and sensory fun.</li>`
    +   `<li>Bring any questions for our team; we love to chat.</li>`
    + `</ul>`
    + `<p style="margin:16px 0 4px">Haven’t confirmed yet? Tap below so we know to expect you:</p>`
    + confirmButton()
    + `<p>The full address is in your Eventbrite confirmation email. If anything changes on your end, `
    + `just reply here and let us know.</p>`
    + `<p>See you soon,<br>The Above &amp; Beyond ABA Team</p>`
  );
  return { subject: c.subject, html };
}

// Decide what (if anything) today's run should send.
function planSend(days, override){
  if(override && override.type === "weekly"){
    return { track:"weekly", weekIndex: override.week ?? weekEpoch() };
  }
  if(override && override.type === "countdown"){
    const off = OFFSETS.includes(override.days) ? override.days : (override.days ?? MAX_OFFSET);
    return { track:"countdown", offset: off };
  }
  if(days === null) return null;
  // Countdown days win over weekly days.
  if(OFFSETS.includes(days)) return { track:"countdown", offset: days };
  // Weekly nurture only while we're still outside the countdown window.
  if(days > MAX_OFFSET && weekdayET() === WEEKLY_DAY) return { track:"weekly", weekIndex: weekEpoch() };
  return null;
}

function authorized(req){
  const secret = process.env.CRON_SECRET;
  if(!secret) return false;
  const auth = req.headers["authorization"] || "";
  const q = (req.query && (req.query.key || req.query.secret)) || "";
  return auth === `Bearer ${secret}` || q === secret;
}

export default async function handler(req, res){
  if(!authorized(req)) return res.status(401).json({error:"unauthorized"});
  const token = process.env.EVENTBRITE_TOKEN;
  if(!token) return res.status(400).json({error:"No EVENTBRITE_TOKEN set"});

  const q = req.query || {};
  const which = (q.event || "wrts").toLowerCase();          // only "wrts" today
  const audience = (q.audience || "all").toLowerCase();     // all | pending
  const force = q.force === "1" || q.force === "true";      // bypass the date gate (manual testing)
  const apiKey = process.env.RESEND_API_KEY;
  const liveEnabled = process.env.REMINDERS_LIVE === "1";

  // Optional manual override for previewing a specific email.
  let override = null;
  if(q.type === "weekly")   override = { type:"weekly", week: q.week!=null ? parseInt(q.week,10) : undefined };
  if(q.type === "countdown")override = { type:"countdown", days: q.days!=null ? parseInt(q.days,10) : undefined };

  let out;
  try { ({out} = await getEvents(token)); }
  catch(e){ return res.status(502).json({error:String(e && e.message || e)}); }

  const ev = out.events.find(e => e.key === which);
  if(!ev) return res.status(404).json({ error:`event "${which}" not found`, events: out.events.map(e=>e.key) });

  const dateISO = EVENT_DATE[which];
  const days = daysUntil(dateISO);
  const plan = (force || override) ? (planSend(days, override) || planSend(days, { type:"weekly" })) : planSend(days, null);

  // De-duplicated recipient list (with time slot), computed from live data.
  const seen = new Set(); const recipients = [];
  for(const f of ev.families){
    if(audience === "pending" && f.confirmed) continue;
    // Never auto-send to families flagged for review unless you've approved them.
    if(f.needsReview && f.reviewStatus !== "approved") continue;
    const email = (f.email||"").trim();
    const key = email.toLowerCase();
    if(!email || seen.has(key)) continue;
    seen.add(key);
    recipients.push({ email, name:f.purchaser||"", slot:(f.slotTime||f.timeslot||"").trim(), order:String(f.order||"") });
  }

  // Build the email for today's plan.
  let built = null;
  if(plan && plan.track === "weekly")    built = weeklyEmail(plan.weekIndex, days ?? 0, dateISO, null);
  if(plan && plan.track === "countdown") built = countdownEmail(plan.offset, days ?? plan.offset, dateISO, null);

  const willSend = liveEnabled && !!apiKey && !!plan && !!built && recipients.length > 0;

  // PREVIEW: report only, send nothing.
  if(!willSend){
    const reasons = [];
    if(!apiKey) reasons.push("RESEND_API_KEY not set");
    if(!liveEnabled) reasons.push("REMINDERS_LIVE not '1' (still in preview)");
    if(!dateISO) reasons.push("EVENT_WRTS_DATE not set");
    if(!plan) reasons.push("today is not a scheduled send day");
    if(!recipients.length) reasons.push("no recipients for this audience");
    return res.status(200).json({
      mode:"preview", today:todayISO(), event:which, audience,
      daysUntil:days, plan: plan ? { ...plan } : null,
      subject: built ? built.subject : null,
      offsets: OFFSETS, weeklyDay: WEEKLY_DAY,
      wouldSend: recipients.length, reasons,
      recipients: recipients.map(r => r.email)
    });
  }

  // LIVE: personalized reminders via Resend's BATCH API (one request per <=100),
  // so a full 50+ recipient send never trips the per-message rate limit.
  const origin = `https://${(req.headers && req.headers.host) || "we-rock-the-spectrum.vercel.app"}`;
  const messages = recipients.map(r=>{
    const first = r.name ? r.name.trim().split(/\s+/)[0] : "there";
    const confirmUrl = `${origin}/api/confirm?o=${encodeURIComponent(r.order)}&s=${sigFor(r.order)}`;
    const perSlot = plan.track === "weekly"
      ? weeklyEmail(plan.weekIndex, days ?? 0, dateISO, r.slot)
      : countdownEmail(plan.offset, days ?? plan.offset, dateISO, r.slot);
    const html = perSlot.html
      .replace(/\{\{\s*first\s*\}\}/gi, esc(first))
      .replace(/\{\{\s*confirm_url\s*\}\}/gi, confirmUrl);
    return { from:FROM, to:[r.email], reply_to:REPLY_TO, subject: perSlot.subject, html };
  });
  // Team copies: one copy of the reminder to internal observers.
  const copyHtml = built.html
    .replace(/\{\{\s*first\s*\}\}/gi, "Team")
    .replace(/\{\{\s*confirm_url\s*\}\}/gi, `${origin}/api/confirm?o=DEMO&s=DEMO`);
  for(const t of TEAM_COPY) messages.push({ from:FROM, to:[t], reply_to:REPLY_TO, subject:`[Team copy] ${built.subject}`, html:copyHtml });

  const results = { sent:0, failed:0, errors:[] };
  for(let i=0;i<messages.length;i+=100){
    const chunk = messages.slice(i, i+100);
    try{
      const resp = await fetch("https://api.resend.com/emails/batch", {
        method:"POST",
        headers:{ "Authorization":`Bearer ${apiKey}`, "Content-Type":"application/json" },
        body: JSON.stringify(chunk)
      });
      if(resp.ok){ results.sent += chunk.length; }
      else { results.failed += chunk.length; const t = await resp.text(); results.errors.push(`batch@${i}: HTTP ${resp.status} ${t.slice(0,160)}`); }
    }catch(err){ results.failed += chunk.length; results.errors.push(`batch@${i}: ${String(err && err.message || err)}`); }
  }
  return res.status(200).json({ mode:"sent", today:todayISO(), event:which, audience, track:plan.track, subject:built.subject, teamCopies:TEAM_COPY.length, ...results });
}
