// Receives Resend webhook events (email.delivered, email.opened, email.clicked,
// email.bounced, ...) and records the recipient in a per-event Redis set so the
// dashboard can show a Delivered -> Opened -> Confirmed funnel.
//
// Set the webhook URL in Resend to:
//   https://we-rock-the-spectrum.vercel.app/api/resend-webhook?key=<CRON_SECRET>
// and enable Open + Click tracking on the domain.

import { recordEmailEvent } from "./_store.js";

function safe(s){ try{ return JSON.parse(s || "{}"); }catch(_){ return {}; } }
function readBody(req){
  return new Promise(resolve=>{
    if(req.body) return resolve(typeof req.body === "string" ? safe(req.body) : req.body);
    let d=""; req.on("data",c=>d+=c); req.on("end",()=>resolve(safe(d))); req.on("error",()=>resolve({}));
  });
}

export default async function handler(req, res){
  const key = (req.query && req.query.key) || "";
  if(key !== String(process.env.CRON_SECRET || "")) return res.status(401).json({ error:"unauthorized" });

  const body = await readBody(req);
  const type = (body && body.type) || "";      // e.g. "email.opened"
  const data = (body && body.data) || {};
  let to = data.to; if(Array.isArray(to)) to = to[0];
  const short = (String(type).split(".")[1] || "").toLowerCase();   // opened | delivered | clicked | bounced
  if(short && to) await recordEmailEvent(short, to);
  return res.status(200).json({ ok:true, event: short || type || "none" });
}
