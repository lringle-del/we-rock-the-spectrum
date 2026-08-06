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
import { listWelcomed, addWelcomed } from "./_store.js";
import crypto from "crypto";

// Signed per-family confirm link (must match api/confirm.js sigFor).
function sigFor(order){
  const secret = process.env.CRON_SECRET || "";
  return crypto.createHmac("sha256", secret).update(String(order)).digest("hex").slice(0, 16);
}
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

// Built-in welcome template so the send can be triggered on a schedule with no
// payload. Placeholders {{first}}, {{slot}}, {{confirm_url}} are filled per family.
const WELCOME = {
  subject: "A warm welcome from Above & Beyond ABA: your Aug 21 details",
  html: `<div style="font-family:Inter,Segoe UI,Arial,sans-serif;font-size:16px;line-height:1.6;color:#1f2430;max-width:560px;margin:0 auto"><p>Hi {{first}},</p><p>Thank you for signing up to We Rock the Spectrum, hosted by Above &amp; Beyond ABA Therapy! We&rsquo;re so glad you and your family are joining us. Here&rsquo;s everything you need for the big day.</p><p style="margin:18px 0 6px;font-weight:600;color:#6b5bd6">Why we&rsquo;re doing this</p><p style="margin:0">At Above &amp; Beyond ABA, we wanted to create an afternoon where children can play at their own pace while parents connect with other local autism families, in a welcoming, no-pressure, and genuinely fun environment. It&rsquo;s completely free, and it&rsquo;s our way of showing up for our community.</p><div style="background:#f4f6fb;border-radius:10px;padding:14px 16px;margin:18px 0"><p style="margin:0 0 8px"><strong>Your details</strong></p>&#128197; Friday, August 21 (event runs 4:00-8:00 PM)<br>&#128336; Your reserved time: <strong>{{slot}}</strong><br>&#128205; We Rock the Spectrum Kids Gym, 10717 Virginia Plaza, Suite 113, La Vista, NE 68128<br>&#127829; Pizza will be served &middot; &#127873; Door prizes!</div><p style="margin:18px 0 6px;font-weight:600;color:#6b5bd6">Wait until you see the space &#129337;</p><p style="margin:0">We Rock the Spectrum is a sensory gym built entirely for kids like yours: a <strong>zip line</strong>, <strong>trampoline</strong>, <strong>climbing structures</strong>, <strong>suspended swings</strong>, sensory play, and an arts &amp; crafts corner, all in one safe, judgment-free place. Their whole motto is <em>&ldquo;Finally a place where you never have to say I&rsquo;m sorry.&rdquo;</em> Take a peek: <a href="https://werockthespectrumomaha.com/" style="color:#6b5bd6;font-weight:600">werockthespectrumomaha.com</a></p><p style="margin:18px 0 4px">Please let us know you&rsquo;re coming so we can plan for pizza and door prizes:</p><div style="text-align:center;margin:8px 0 24px"><a href="{{confirm_url}}" style="display:inline-block;background:#6b5bd6;color:#ffffff;text-decoration:none;font-weight:700;padding:14px 30px;border-radius:8px;font-size:16px">I confirm my spot</a></div><p>Come as you are, dress comfy, and bring your questions. We&rsquo;d love to meet you. If anything changes, just reply to this email.</p><p>See you there!</p><p>Warmly,<br>The Above &amp; Beyond ABA Team</p></div>`
};

export default async function handler(req, res){
  if(req.method !== "POST") return res.status(405).json({ error:"POST only" });
  const token = process.env.EVENTBRITE_TOKEN;
  if(!token) return res.status(400).json({ error:"No EVENTBRITE_TOKEN set" });

  const body = await readBody(req);
  const template = String(body.template || (req.query && req.query.template) || "").toLowerCase();
  const which = String(body.event || (req.query && req.query.event) || (template ? "wrts" : "")).toLowerCase();
  const audience = String(body.audience || (req.query && req.query.audience) || "all").toLowerCase(); // all | pending
  let subject = String(body.subject || "").trim();
  let html = String(body.html || body.body || "").trim();
  if(template === "welcome"){ subject = WELCOME.subject; html = WELCOME.html; }
  const key = String(body.key || (req.query && req.query.key) || "");

  const secret = process.env.SEND_SECRET || process.env.CRON_SECRET || "";
  const authed = !!secret && key === secret;
  const apiKey = process.env.RESEND_API_KEY;
  const liveEnabled = process.env.EMAIL_LIVE === "1";
  const FROM = process.env.EMAIL_FROM || process.env.REMINDER_FROM || "Above & Beyond ABA <events@updates.abtaba.com>";
  // updates.abtaba.com can't receive mail (no inbound MX), so replies go to a real inbox.
  const REPLY_TO = process.env.EMAIL_REPLY_TO || "lringle@abtaba.com";
  // Internal observers who receive one copy of each approved campaign send.
  const TEAM_COPY = (process.env.TEAM_COPY || "jmayerovitz@abtaba.com,koneil@abtaba.com").split(",").map(s=>s.trim()).filter(Boolean);
  const testTo = String(body.testTo || (req.query && req.query.testTo) || "").trim();

  // TEST MODE: send a single sample to one address (e.g. yourself) so the
  // design can be reviewed BEFORE going live. Bypasses EMAIL_LIVE on purpose,
  // but still requires the passphrase + an API key. Uses example personalization.
  if(testTo){
    if(!authed) return res.status(200).json({ mode:"test-blocked", reason:"passphrase missing/incorrect" });
    if(!apiKey) return res.status(200).json({ mode:"test-blocked", reason:"RESEND_API_KEY not set" });
    if(!subject || !html) return res.status(200).json({ mode:"test-blocked", reason:"subject or message is empty" });
    const previewConfirm = `https://${(req.headers && req.headers.host) || "we-rock-the-spectrum.vercel.app"}/api/confirm?o=SELFTEST&s=${sigFor("SELFTEST")}`;
    const personalized = html
      .replace(/\{\{\s*first\s*\}\}/gi, "Liba")
      .replace(/\{\{\s*(slot|time)\s*\}\}/gi, "6:45 PM")
      .replace(/\{\{\s*confirm_url\s*\}\}/gi, previewConfirm);
    // Allow a from-override for the sample so it can go out via Resend's test
    // sender (onboarding@resend.dev) before abtaba.com is verified.
    const testFrom = String(body.from || (req.query && req.query.from) || FROM).trim();
    try{
      const resp = await fetch("https://api.resend.com/emails", {
        method:"POST",
        headers:{ "Authorization":`Bearer ${apiKey}`, "Content-Type":"application/json" },
        body: JSON.stringify({ from:testFrom, to:[testTo], reply_to:REPLY_TO, subject:`[SAMPLE] ${subject}`, html:personalized })
      });
      const detail = resp.ok ? null : await resp.text();
      return res.status(200).json({ mode:"test-sent", to:testTo, ok:resp.ok, status:resp.status, detail });
    }catch(err){ return res.status(200).json({ mode:"test-error", to:testTo, error:String(err && err.message || err) }); }
  }

  let out;
  try { ({ out } = await getEvents(token)); }
  catch(e){ return res.status(502).json({ error:String(e && e.message || e) }); }

  const ev = out.events.find(e => e.key === which);
  if(!ev) return res.status(404).json({ error:`event "${which}" not found`, events: out.events.map(e=>e.key) });

  // De-duplicated recipient list, computed from live data.
  const seen = new Set(); const recipients = [];
  for(const f of ev.families){
    if(audience === "pending" && f.confirmed) continue;
    // Never auto-send to families flagged for review unless you've approved them.
    if(f.needsReview && f.reviewStatus !== "approved") continue;
    const email = (f.email || "").trim();
    const k = email.toLowerCase();
    if(!email || seen.has(k)) continue;
    seen.add(k);
    recipients.push({ email, name: f.purchaser || "", slot: (f.slotTime || f.timeslot || "").trim(), order: String(f.order || "") });
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
      recipients: recipients.map(r => r.email),
      // First few with their resolved time slot, so slot personalization can be verified.
      sample: recipients.slice(0,6).map(r => ({ email:r.email, first:(r.name||"").trim().split(/\s+/)[0]||"there", slot:r.slot||"(none)" }))
    });
  }

  // LIVE: personalized emails via Resend's BATCH API (one request per <=100),
  // so we never trip the per-message rate limit that caused earlier 429s.
  const origin = `https://${(req.headers && req.headers.host) || "we-rock-the-spectrum.vercel.app"}`;
  const isWelcome = template === "welcome";
  // Optional targeted resend to specific addresses only (comma-separated).
  const onlySet = new Set(String(body.only || (req.query && req.query.only) || "").split(",").map(s=>s.trim().toLowerCase()).filter(Boolean));
  // Per-recipient idempotency for the welcome (skip anyone already welcomed).
  let welcomedSet = new Set();
  if(isWelcome){ try{ welcomedSet = new Set((await listWelcomed()).map(x=>String(x).toLowerCase())); }catch(_){} }

  const targets = recipients.filter(r=>{
    const e = r.email.toLowerCase();
    if(onlySet.size && !onlySet.has(e)) return false;      // targeted resend
    if(isWelcome && !onlySet.size && welcomedSet.has(e)) return false; // already welcomed
    return true;
  });

  const messages = targets.map(r=>{
    const first = r.name ? r.name.trim().split(/\s+/)[0] : "there";
    const slot = r.slot || "your reserved time";
    const confirmUrl = `${origin}/api/confirm?o=${encodeURIComponent(r.order)}&s=${sigFor(r.order)}`;
    const personalized = html
      .replace(/\{\{\s*first\s*\}\}/gi, esc(first))
      .replace(/\{\{\s*(slot|time)\s*\}\}/gi, esc(slot))
      .replace(/\{\{\s*confirm_url\s*\}\}/gi, confirmUrl);
    return { from:FROM, to:[r.email], reply_to:REPLY_TO, subject, html:personalized };
  });

  // Team copies only on a full send, not on a targeted `only` resend.
  if(!onlySet.size){
    const copyHtml = html
      .replace(/\{\{\s*first\s*\}\}/gi, "Team")
      .replace(/\{\{\s*(slot|time)\s*\}\}/gi, "(each family sees their own time)")
      .replace(/\{\{\s*confirm_url\s*\}\}/gi, `${origin}/api/confirm?o=DEMO&s=DEMO`);
    for(const t of TEAM_COPY) messages.push({ from:FROM, to:[t], reply_to:REPLY_TO, subject:`[Team copy] ${subject}`, html:copyHtml });
  }

  const results = { sent:0, failed:0, skipped: recipients.length - targets.length, errors:[] };
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
  // Record welcomed recipients so we never welcome them twice.
  if(isWelcome && results.sent > 0){ try{ await addWelcomed(targets.map(r=>r.email)); }catch(_){} }

  return res.status(200).json({ mode:"sent", event:which, audience, template: template||null, teamCopies: onlySet.size?0:TEAM_COPY.length, ...results });
}
