// Server-side one-time trigger for the welcome send. Driven by a Vercel Cron so
// it runs even if nobody's app is open. A Redis "claim" guarantees it fires only
// once no matter how many times the cron (or a manual call) hits it.
//
// Auth: Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` automatically
// when CRON_SECRET is set; a manual call can pass ?key=CRON_SECRET instead.
// Manual controls: ?status=1 (report only), ?reset=1 (clear the guard to allow a resend).

import { claimOnce, releaseOnce, wasClaimed } from "./_store.js";

const FLAG = "welcome_sent";

export default async function handler(req, res){
  const secret = process.env.CRON_SECRET || "";
  const auth = req.headers["authorization"] || "";
  const key = (req.query && req.query.key) || "";
  if(!(auth === `Bearer ${secret}` || key === secret)) return res.status(401).json({ error:"unauthorized" });

  if(req.query && req.query.status) return res.status(200).json({ alreadySent: await wasClaimed(FLAG) });
  if(req.query && req.query.reset){ await releaseOnce(FLAG); return res.status(200).json({ reset:true }); }

  // Claim atomically; only the first caller proceeds.
  const first = await claimOnce(FLAG);
  if(!first) return res.status(200).json({ skipped:true, reason:"welcome already sent" });

  // Trigger the actual send via the compose endpoint's built-in welcome template.
  const origin = `https://${(req.headers && req.headers.host) || "we-rock-the-spectrum.vercel.app"}`;
  try{
    const r = await fetch(`${origin}/api/send-email?template=welcome&key=${encodeURIComponent(secret)}`, {
      method:"POST", headers:{ "Content-Type":"application/json" }, body:"{}"
    });
    const d = await r.json();
    // If it did not actually send, release the guard so it can be retried.
    if(!d || d.mode !== "sent"){ await releaseOnce(FLAG); return res.status(200).json({ triggered:false, result:d }); }
    return res.status(200).json({ triggered:true, result:d });
  }catch(err){
    await releaseOnce(FLAG);
    return res.status(200).json({ triggered:false, error:String(err && err.message || err) });
  }
}
