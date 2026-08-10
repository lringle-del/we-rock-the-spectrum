// Imports Microsoft Form registrations (parsed from the exported spreadsheet)
// so they merge into the dashboard alongside Eventbrite families and can be
// welcomed. Upserts by email, so re-uploading the latest export is safe and
// only adds people who are new.
//
// POST { key, families:[{email,name,phone,slot,children:[{child,age,dx,aba,looking}]}] }

import { saveFormFamilies } from "./_store.js";

function safe(s){ try{ return JSON.parse(s || "{}"); }catch(_){ return {}; } }
function readBody(req){
  return new Promise(resolve=>{
    if(req.body) return resolve(typeof req.body === "string" ? safe(req.body) : req.body);
    let d=""; req.on("data",c=>d+=c); req.on("end",()=>resolve(safe(d))); req.on("error",()=>resolve({}));
  });
}

export default async function handler(req, res){
  if(req.method !== "POST") return res.status(405).json({ error:"POST only" });
  const body = await readBody(req);
  const key = String(body.key || (req.query && req.query.key) || "");
  if(key !== String(process.env.CRON_SECRET || "")) return res.status(401).json({ error:"unauthorized" });
  const families = Array.isArray(body.families) ? body.families : [];
  const { added, total } = await saveFormFamilies(families);
  return res.status(200).json({ ok:true, received: families.length, added, addedCount: added.length, totalForm: total });
}
