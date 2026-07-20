// On-demand email sender for the Above & Beyond ABA event dashboard.
// The "Compose email" panel POSTs here. It is SAFE BY DEFAULT and only
// actually sends when ALL of these are true — otherwise it returns a preview
// (who it would email) and sends nothing:
//   1. the caller supplies the correct passphrase (SEND_SECRET / CRON_SECRET), AND
//   2. RESEND_API_KEY is set, AND
//   3. EMAIL_LIVE === "1"  (the master "go live" switch), AND
//   4. there is a subject, a body, and at least one recipient.
//
// Recipients are computed SERVER-SIDE from the live Eventbrite data, so the
// browser never has to be trusted with the full list and the token stays private.
//
// Env vars: EVENTBRITE_TOKEN (required), SEND_SECRET (or CRON_SECRET),
//   RESEND_API_KEY, EMAIL_LIVE, EMAIL_FROM (optional).

import { getEvents } from "./attendees.js";

function safeParse(s){ try{ return JSON.parse(s || "{}"); }catch(_){ return {}; } }
function readBody(req){
  return new Promise(resolve=>{
    if(req.body) return resolve(typeof req.body === "string" ? safeParse(req.body) : req.body);
    let data=""; req.on("data",c=>data+=c);
    req.on("end",()=>resolve(safeParse(data)));
    req.on("error",()=>resolve({}));
  });
}
function esc(s){ return String(s||"").replace(/[&<>]/g, c=>({ "&":"&amp;","<":"&lt;",">":"&gt;" }[c])); }

export default async function handler(req, res){
  if(req.method !== "POST") return res.status(405).json({ error:"POST only" });
  const token = process.env.EVENTBRITE_TOKEN;
  if(!token) return res.status(400).json({ error:"No EVENTBRITE_TOKEN set" });

  const body = await readBody(req);
  const which = String(body.event || "").toLowerCase();
  const audience = String(body.audience || "all").toLowerCase(); // all | pending
  const subject = String(body.subject || "").trim();
  const html = String(body.html || body.body || "").trim();
  const key = String(body.key || (req.query && req.query.key) || "");

  const secret = process.env.SEND_SECRET || process.env.CRON_SECRET || "";
  const authed = !!secret && key === secret;
  const apiKey = process.env.RESEND_API_KEY;
  const liveEnabled = process.env.EMAIL_LIVE === "1";
  const FROM = process.env.EMAIL_FROM || process.env.REMINDER_FROM || "Above & Beyond ABA <events@abtaba.com>";

  let out;
  try { ({ out } = await getEvents(token)); }
  catch(e){ return res.status(502).json({ error:String(e && e.message || e) }); }

  const ev = out.events.find(e => e.key === which);
  if(!ev) return res.status(404).json({ error:`event "${which}" not found`, events: out.events.map(e=>e.key) });

  // De-duplicated recipient list, computed from live data.
  const seen = new Set(); const recipients = [];
  for(const f of ev.families){
    if(audience === "pending" && f.confirmed) continue;
    const email = (f.email || "").trim();
    const k = email.toLowerCase();
    if(!email || seen.has(k)) continue;
    seen.add(k);
    recipients.push({ email, name: f.purchaser || "" });
  }

  const willSend = authed && liveEnabled && !!apiKey && recipients.length > 0 && !!subject && !!html;

  // PREVIEW: report only, send nothing.
  if(!willSend){
    const reasons = [];
    if(!authed) reasons.push("passphrase missing/incorrect (sending disabled)");
    if(!apiKey) reasons.push("RESEND_API_KEY not set");
    if(!liveEnabled) reasons.push("EMAIL_LIVE not '1' (still in preview)");
    if(!subject || !html) reasons.push("subject or message is empty");
    if(!recipients.length) reasons.push("no recipients for this audience");
    return res.status(200).json({
      mode:"preview", event:which, audience,
      wouldSend: recipients.length, reasons,
      recipients: recipients.map(r => r.email)
    });
  }

  // LIVE: one personalized email per recipient via Resend.
  const results = { sent:0, failed:0, errors:[] };
  for(const r of recipients){
    const first = r.name ? r.name.trim().split(/\s+/)[0] : "there";
    const personalized = html.replace(/\{\{\s*first\s*\}\}/gi, esc(first));
    try{
      const resp = await fetch("https://api.resend.com/emails", {
        method:"POST",
        headers:{ "Authorization":`Bearer ${apiKey}`, "Content-Type":"application/json" },
        body: JSON.stringify({ from:FROM, to:[r.email], subject, html:personalized })
      });
      if(resp.ok) results.sent++;
      else { results.failed++; if(results.errors.length < 5) results.errors.push(`${r.email}: HTTP ${resp.status}`); }
    }catch(err){ results.failed++; if(results.errors.length < 5) results.errors.push(`${r.email}: ${String(err && err.message || err)}`); }
  }
  return res.status(200).json({ mode:"sent", event:which, audience, ...results });
}
