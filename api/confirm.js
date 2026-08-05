// Public "I confirm my spot" endpoint. A family taps a signed link in their
// email; this marks them confirmed (shows on the dashboard) and auto-sends the
// "You're confirmed" email once. No login: each link carries an HMAC signature.

import crypto from "crypto";
import { getEvents } from "./attendees.js";
import { addConfirmed, isConfirmed, ping, listConfirmed } from "./_store.js";

// Same signing scheme the email sender uses to build the link.
export function sigFor(order){
  const secret = process.env.CRON_SECRET || "";
  return crypto.createHmac("sha256", secret).update(String(order)).digest("hex").slice(0, 16);
}
function esc(s){ return String(s||"").replace(/[&<>"]/g, c=>({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;" }[c])); }

function page(title, inner){
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>`
    + `<body style="font-family:Inter,Segoe UI,Arial,sans-serif;background:#f3f4f8;margin:0;padding:44px 16px;color:#1f2430">`
    + `<div style="max-width:480px;margin:0 auto;background:#fff;border-radius:16px;padding:34px 28px;text-align:center;box-shadow:0 1px 4px rgba(20,25,40,.08)">${inner}</div></body></html>`;
}

// La Vista, NE is Central (CDT, UTC-5 in August). Build a Google Calendar link
// for the family's slot, ending at the event close (8:00 PM CT).
function calStartUTC(slot){
  const m = String(slot||"").match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if(!m) return "20260821T210000Z";
  let h = (+m[1]) % 12; if(/pm/i.test(m[3])) h += 12;
  const uh = String(h + 5).padStart(2,"0");
  return `20260821T${uh}${m[2]}00Z`;
}
function calLink(slot){
  const text = encodeURIComponent("We Rock the Spectrum - Free Family Afternoon");
  const loc  = encodeURIComponent("We Rock the Spectrum Kids Gym, 10717 Virginia Plaza, Suite 113, La Vista, NE 68128");
  const det  = encodeURIComponent(`Your reserved time is ${slot||"in your confirmation"}. Food and door prizes!`);
  return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${text}&dates=${calStartUTC(slot)}/20260822T010000Z&location=${loc}&details=${det}`;
}

function confirmedEmailHtml(first, slot){
  return `<div style="font-family:Inter,Segoe UI,Arial,sans-serif;font-size:16px;line-height:1.6;color:#1f2430;max-width:560px;margin:0 auto">`
    + `<p>Hi ${esc(first)},</p>`
    + `<p><strong>You're all set, thank you for confirming!</strong> It truly means a lot to us.</p>`
    + `<p>We wanted to share <em>why</em> this afternoon matters so much. Every day, we see how much lighter the world feels for a child when they're somewhere built for them, where they can move, play, and be themselves without anyone asking them to be different.</p>`
    + `<p>We created this event to give families in our community one afternoon of exactly that: no pressure, no cost, no agenda. Just kids playing their way, and parents connecting with others who get it.</p>`
    + `<div style="background:#f4f6fb;border-radius:10px;padding:14px 16px;margin:18px 0"><p style="margin:0 0 8px"><strong>Your details (save them!)</strong></p>`
    +   `&#128197; Friday, August 21 &middot; your time: <strong>${esc(slot||"see your registration")}</strong><br>`
    +   `&#128205; We Rock the Spectrum Kids Gym, 10717 Virginia Plaza, Suite 113, La Vista, NE 68128<br>`
    +   `&#127869;&#65039; Food &middot; &#127873; Door prizes</div>`
    + `<div style="text-align:center;margin:8px 0 24px"><a href="${calLink(slot)}" style="display:inline-block;background:#1f9d55;color:#fff;text-decoration:none;font-weight:700;padding:14px 30px;border-radius:8px;font-size:16px">&#128197; Add to my calendar</a></div>`
    + `<p>We can't wait to share it with you.</p><p>Warmly,<br>The Above &amp; Beyond ABA Team</p></div>`;
}

async function sendConfirmedEmail(fam){
  const apiKey = process.env.RESEND_API_KEY;
  if(!apiKey || !fam || !fam.email) return;
  const FROM = process.env.EMAIL_FROM || process.env.REMINDER_FROM || "Above & Beyond ABA <events@updates.abtaba.com>";
  const REPLY_TO = process.env.EMAIL_REPLY_TO || "lringle@abtaba.com";
  const first = (fam.purchaser || "").trim().split(/\s+/)[0] || "there";
  const slot  = (fam.slotTime || fam.timeslot || "").trim();
  await fetch("https://api.resend.com/emails", {
    method:"POST",
    headers:{ "Authorization":`Bearer ${apiKey}`, "Content-Type":"application/json" },
    body: JSON.stringify({ from:FROM, to:[fam.email], reply_to:REPLY_TO,
      subject:"You're confirmed! Here's the heart behind our afternoon",
      html: confirmedEmailHtml(first, slot) })
  });
}

export default async function handler(req, res){
  const q = req.query || {};

  // Self-test: /api/confirm?ping=1&key=CRON_SECRET  (also shows confirmed count)
  if(q.ping){
    if(String(q.key||"") !== String(process.env.CRON_SECRET||"")) return res.status(401).json({ error:"unauthorized" });
    return res.status(200).json({ hasRedisUrl: !!process.env.REDIS_URL, redisOk: await ping(), confirmedCount: (await listConfirmed()).length });
  }

  const order = String(q.o || "").trim();
  const s = String(q.s || "").trim();
  res.setHeader("Content-Type","text/html; charset=utf-8");

  if(!order || s !== sigFor(order)){
    return res.status(400).send(page("Invalid link",
      `<div style="font-size:40px">🤔</div><h2 style="margin:10px 0">This link looks invalid</h2>`
      + `<p style="color:#5b6270">Please use the button in your email, or just reply and we'll help you confirm.</p>`));
  }

  const already = await isConfirmed(order);
  await addConfirmed(order);

  // Find the family to personalize the page and send the confirmation once.
  let fam = null;
  try{
    const { out } = await getEvents(process.env.EVENTBRITE_TOKEN);
    const ev = out.events.find(e => e.key === "wrts");
    fam = ev && ev.families.find(f => String(f.order) === order);
  }catch(_){}

  if(!already){ try{ await sendConfirmedEmail(fam); }catch(_){} }

  const first = fam && fam.purchaser ? esc(fam.purchaser.trim().split(/\s+/)[0]) : "there";
  return res.status(200).send(page("You're confirmed!",
    `<div style="font-size:46px">🎉</div><h2 style="margin:10px 0 6px">You're confirmed!</h2>`
    + `<p style="font-size:17px">Thanks, ${first}! We can't wait to see your family on <strong>Friday, August 21</strong>.</p>`
    + `<p style="color:#8a90a0;font-size:13px;margin-top:18px">A confirmation email with all the details is on its way.</p>`));
}
