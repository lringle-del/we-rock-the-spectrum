// Tiny Redis helper for confirmations and approvals.
// Uses the REDIS_URL added by the Vercel Redis (Marketplace) integration.
// Every call is best-effort: if Redis is unavailable, it degrades quietly so
// the dashboard and emails never break because of the store.

import { createClient } from "redis";

let client = null;
async function getClient(){
  if(!process.env.REDIS_URL) return null;
  if(client && client.isOpen) return client;
  try{
    client = createClient({ url: process.env.REDIS_URL, socket:{ connectTimeout: 3000 } });
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
