// Tiny Redis helper for confirmations and approvals.
// Uses the REDIS_URL added by the Vercel Redis (Marketplace) integration.
// Every call is best-effort: if Redis is unavailable, it degrades quietly so
// the dashboard and emails never break because of the store.

// Redis is imported lazily inside getClient so a load/build issue with the
// module can never crash the whole function at startup. If anything fails, we
// return null and every caller degrades quietly.
let client = null;
let _createClient = null;
async function getClient(){
  if(!process.env.REDIS_URL) return null;
  if(client && client.isOpen) return client;
  try{
    if(!_createClient){ const m = await import("redis"); _createClient = m.createClient || (m.default && m.default.createClient); }
    if(!_createClient) return null;
    client = _createClient({ url: process.env.REDIS_URL, socket:{ connectTimeout: 3000 } });
    client.on("error", ()=>{});
    await client.connect();
  }catch(_){ client = null; }
  return client;
}

const CONFIRMED = "wrts:confirmed";       // set of Eventbrite order ids
const APPROVED  = "wrts:approved";        // set of send ids the approver has approved
const PREVIEWED = "wrts:previewed";       // set of send ids whose approval preview was emailed
const REVIEW    = "wrts:review";          // hash: order id -> "approved" | "declined"
const FLAGS     = "wrts:flags";           // set of one-time flags (e.g. welcome_sent)
const WELCOMED  = "wrts:welcomed";        // set of emails already sent the welcome (idempotency)
const SENTDATES = "wrts:sentReminderDates"; // set of ISO dates a reminder ACTUALLY sent (sent>0)

// --- real reminder-send tracking (so the dashboard shows truth, not guesses) ---
export async function recordReminderSentDate(dateISO){
  const c = await getClient(); if(!c) return;
  try{ await c.sAdd(SENTDATES, String(dateISO)); }catch(_){}
}
export async function listSentReminderDates(){
  const c = await getClient(); if(!c) return [];
  try{ return await c.sMembers(SENTDATES); }catch(_){ return []; }
}

// --- email delivery/open/click tracking (fed by the Resend webhook) ---
export async function recordEmailEvent(type, email){
  const c = await getClient(); if(!c) return;
  const t = String(type||"").toLowerCase().replace(/[^a-z]/g,"");
  if(!t || !email) return;
  try{ await c.sAdd("wrts:evt:"+t, String(email).toLowerCase()); }catch(_){}
}
export async function emailEventCount(type){
  const c = await getClient(); if(!c) return 0;
  const t = String(type||"").toLowerCase().replace(/[^a-z]/g,"");
  try{ return await c.sCard("wrts:evt:"+t); }catch(_){ return 0; }
}

// --- Microsoft Form families (upserted by email; merged into the dashboard) ---
const FORMFAM = "wrts:formfam";   // hash: email(lower) -> JSON family
export async function saveFormFamilies(families){
  const c = await getClient(); if(!c) return { added:[], total:0 };
  const added = [];
  for(const f of families||[]){
    const email = String(f&&f.email||"").trim().toLowerCase(); if(!email) continue;
    try{ const isNew = !(await c.hExists(FORMFAM, email)); await c.hSet(FORMFAM, email, JSON.stringify(f)); if(isNew) added.push(email); }catch(_){}
  }
  let total = 0; try{ total = await c.hLen(FORMFAM); }catch(_){}
  return { added, total };
}
export async function listFormFamilies(){
  const c = await getClient(); if(!c) return [];
  try{ const h = await c.hGetAll(FORMFAM); return Object.values(h||{}).map(v=>{ try{ return JSON.parse(v); }catch(_){ return null; } }).filter(Boolean); }catch(_){ return []; }
}
export async function removeFormFamilies(emails){
  const c = await getClient(); if(!c) return 0; let n=0;
  for(const e of [].concat(emails||[])){ try{ n += await c.hDel(FORMFAM, String(e).trim().toLowerCase()); }catch(_){} }
  return n;
}

// --- welcome idempotency (never welcome the same email twice) ---
export async function listWelcomed(){
  const c = await getClient(); if(!c) return [];
  try{ return await c.sMembers(WELCOMED); }catch(_){ return []; }
}
export async function addWelcomed(emails){
  const c = await getClient(); if(!c) return;
  const arr = [].concat(emails).map(e=>String(e).toLowerCase()).filter(Boolean);
  if(!arr.length) return;
  try{ await c.sAdd(WELCOMED, arr); }catch(_){}
}

// Atomically claim a one-time send so it can never fire twice. Returns true to
// the FIRST caller only. If Redis is unavailable it returns true (degrade to send).
export async function claimOnce(flag){
  const c = await getClient(); if(!c) return true;
  try{ return (await c.sAdd(FLAGS, String(flag))) === 1; }catch(_){ return true; }
}
export async function releaseOnce(flag){
  const c = await getClient(); if(!c) return;
  try{ await c.sRem(FLAGS, String(flag)); }catch(_){}
}
export async function wasClaimed(flag){
  const c = await getClient(); if(!c) return false;
  try{ return !!(await c.sIsMember(FLAGS, String(flag))); }catch(_){ return false; }
}

// --- review decisions for flagged (non-autism-community) families ---
export async function setReview(order, status){
  const c = await getClient(); if(!c) return null;
  try{ return await c.hSet(REVIEW, String(order), String(status)); }catch(_){ return null; }
}
export async function getReviewMap(){
  const c = await getClient(); if(!c) return {};
  try{ return (await c.hGetAll(REVIEW)) || {}; }catch(_){ return {}; }
}

// --- diagnostics ---
export async function ping(){
  const c = await getClient(); if(!c) return false;
  try{ await c.set("wrts:ping","ok",{EX:60}); return (await c.get("wrts:ping"))==="ok"; }
  catch(_){ return false; }
}

// --- confirmations ---
export async function addConfirmed(order){
  const c = await getClient(); if(!c) return null;
  try{ return await c.sAdd(CONFIRMED, String(order)); }catch(_){ return null; }
}
export async function isConfirmed(order){
  const c = await getClient(); if(!c) return false;
  try{ return !!(await c.sIsMember(CONFIRMED, String(order))); }catch(_){ return false; }
}
export async function listConfirmed(){
  const c = await getClient(); if(!c) return [];
  try{ return await c.sMembers(CONFIRMED); }catch(_){ return []; }
}
export async function removeConfirmed(order){
  const c = await getClient(); if(!c) return null;
  try{ return await c.sRem(CONFIRMED, String(order)); }catch(_){ return null; }
}

// --- approvals (day-before "approve and send" flow) ---
export async function markApproved(sendId){
  const c = await getClient(); if(!c) return null;
  try{ return await c.sAdd(APPROVED, String(sendId)); }catch(_){ return null; }
}
export async function isApproved(sendId){
  const c = await getClient(); if(!c) return false;
  try{ return !!(await c.sIsMember(APPROVED, String(sendId))); }catch(_){ return false; }
}
export async function markPreviewed(sendId){
  const c = await getClient(); if(!c) return null;
  try{ return await c.sAdd(PREVIEWED, String(sendId)); }catch(_){ return null; }
}
export async function wasPreviewed(sendId){
  const c = await getClient(); if(!c) return false;
  try{ return !!(await c.sIsMember(PREVIEWED, String(sendId))); }catch(_){ return false; }
}
