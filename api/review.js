// Authenticated review action for flagged (non-autism-community) families.
// The dashboard calls this when you click Approve or Decline. It stores the
// decision and, only when EMAIL_LIVE=1, sends the matching email:
//   approve  -> the normal "You're confirmed" email (and marks them confirmed)
//   decline  -> the polite "this event is for the autism community" email
// Nothing here ever fires on its own; it only runs on your click.

import { getEvents } from "./attendees.js";
import { sendConfirmedEmail } from "./confirm.js";
import { setReview, addConfirmed } from "./_store.js";

function esc(s){ return String(s||"").replace(/[&<>"]/g, c=>({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;" }[c])); }

function declineHtml(first){
  return `<div style="font-family:Inter,Segoe UI,Arial,sans-serif;font-size:16px;line-height:1.6;color:#1f2430;max-width:560px;margin:0 auto">`
    + `<p>Hi ${esc(first)},</p>`
    + `<p>Thank you so much for your interest in our free family afternoon at We Rock the Spectrum on August 21.</p>`
    + `<p>This event was created specifically for children on the autism spectrum and their families, and because space is very limited, we are only able to welcome families from the autism community this time. We are truly sorry that we cannot hold a spot for you on this occasion.</p>`
    + `<p>We hope to offer events open to more families in the future, and we would love to welcome you then. Thank you so much for understanding.</p>`
    + `<p>Warmly,<br>The Above &amp; Beyond ABA Team</p></div>`;
}

async function sendDecline(fam){
  const apiKey = process.env.RESEND_API_KEY;
  if(process.env.EMAIL_LIVE !== "1") return false;   // master "go live" switch
  if(!apiKey || !fam || !fam.email) return false;
  const FROM = process.env.EMAIL_FROM || process.env.REMINDER_FROM || "Above & Beyond ABA <events@updates.abtaba.com>";
  const REPLY_TO = (process.env.EMAIL_REPLY_TO || "lringle@abtaba.com,jmayerovitz@abtaba.com,koneil@abtaba.com").split(",").map(s=>s.trim()).filter(Boolean);
  const first = (fam.purchaser || "").trim().split(/\s+/)[0] || "there";
  const resp = await fetch("https://api.resend.com/emails", {
    method:"POST",
    headers:{ "Authorization":`Bearer ${apiKey}`, "Content-Type":"application/json" },
    body: JSON.stringify({ from:FROM, to:[fam.email], reply_to:REPLY_TO,
      subject:"About your spot at the We Rock the Spectrum event",
      html: declineHtml(first) })
  });
  return resp.ok;
}

export default async function handler(req, res){
  const q = req.query || {};
  const key = String(q.key || (req.headers && req.headers["x-review-key"]) || "");
  if(key !== String(process.env.CRON_SECRET || "")) return res.status(401).json({ error:"unauthorized" });

  const order = String(q.order || q.o || "").trim();
  const action = String(q.action || "").trim().toLowerCase();
  if(!order || !["approve","decline"].includes(action)) return res.status(400).json({ error:"need order and action=approve|decline" });

  // Look up the family.
  let fam = null;
  try{
    const { out } = await getEvents(process.env.EVENTBRITE_TOKEN);
    const ev = out.events.find(e => e.key === "wrts");
    fam = ev && ev.families.find(f => String(f.order) === order);
  }catch(e){ return res.status(502).json({ error:String(e && e.message || e) }); }
  if(!fam) return res.status(404).json({ error:"family not found for that order" });

  const live = process.env.EMAIL_LIVE === "1";
  if(action === "approve"){
    await setReview(order, "approved");
    await addConfirmed(order);            // shows as confirmed on the dashboard
    let emailSent = false;
    try{ await sendConfirmedEmail(fam); emailSent = live && !!process.env.RESEND_API_KEY; }catch(_){}
    return res.status(200).json({ ok:true, order, action:"approve", emailSent, live });
  }
  // decline
  await setReview(order, "declined");
  let emailSent = false;
  try{ emailSent = await sendDecline(fam); }catch(_){}
  return res.status(200).json({ ok:true, order, action:"decline", emailSent, live });
}
