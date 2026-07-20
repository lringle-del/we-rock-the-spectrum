// Secure Eventbrite sync for the Above & Beyond ABA event dashboard.
// The private Eventbrite token lives ONLY in the Vercel Environment Variable
// EVENTBRITE_TOKEN and is never sent to the browser.

const BASE = "https://www.eventbriteapi.com/v3";
// Test / non-attendee registrations to exclude from every count.
const TEST_EMAILS = new Set([
  "lringle@abtaba.com",
  "david@stradg.com",
  "kristen.porras@powerdigitalmarketinginc.com"
]);
const isTest = e => TEST_EMAILS.has((e||"").trim().toLowerCase());
// Known "Free Event at We Rock the Spectrum Kids Gym" listing(s). Used as a
// fallback so the tab works even if name-based discovery misses it. Override
// entirely with the EVENT_WRTS env var (comma-separated ids).
const DEFAULT_WRTS_IDS = ["1993615746364"];

function h(t){ return { Authorization: `Bearer ${t}` }; }
async function ebGet(path, token, params={}){
  const url = new URL(BASE + path);
  for (const [k,v] of Object.entries(params)) if (v!=null) url.searchParams.set(k,v);
  const r = await fetch(url,{headers:h(token)});
  if(!r.ok) throw new Error(`Eventbrite ${path} -> ${r.status}`);
  return r.json();
}
async function allAttendees(eventId, token){
  let out=[], cont=null, page=1, guard=0;
  // Eventbrite returns attendees ~50 at a time. Walk every page via the
  // continuation token, falling back to page numbers if no token is given.
  while(++guard<=200){
    const params={};
    if(cont) params.continuation=cont;
    else if(page>1) params.page=page;
    const d = await ebGet(`/events/${eventId}/attendees/`, token, params);
    const batch = d.attendees||[];
    out = out.concat(batch);
    const p = d.pagination||{};
    if(p.has_more_items && p.continuation){ cont=p.continuation; page++; continue; }
    if(p.has_more_items && p.page_count && page<p.page_count && batch.length){ page++; continue; }
    break;
  }
  return out;
}
function findAnswer(answers, keywords){
  for(const a of answers||[]){
    const q=(a.question||"").toLowerCase();
    if(keywords.every(k=>q.includes(k))) return (a.answer||"").trim();
  }
  return "";
}
function attendeeToChild(at){
  const ans=at.answers||[];
  return {
    child: findAnswer(ans,["child","name"]),
    age: findAnswer(ans,["child","age"]),
    dx: findAnswer(ans,["autism","diagnosis"]),
    aba: findAnswer(ans,["receiving","aba"]),
    looking: findAnswer(ans,["looking","aba"]),
    gain: findAnswer(ans,["gain"]) || findAnswer(ans,["get","out","event"]),
    haircut: findAnswer(ans,["haircut"]),
    // Every question/answer on this registration, verbatim (drives the
    // "all questions" dynamic view). Blank questions are skipped.
    qa: (ans||[]).map(a=>({q:(a.question||"").trim(), a:(a.answer||"").trim()})).filter(x=>x.q)
  };
}
function buildFamilies(attendees){
  const orders=new Map();
  for(const at of attendees){
    if(at.cancelled||at.refunded) continue;
    const email=((at.profile&&at.profile.email)||"").trim();
    if(isTest(email)) continue;
    const oid=String(at.order_id||at.id);
    if(!orders.has(oid)) orders.set(oid,{source:"Eventbrite",order:oid,
      date:(at.created||"").slice(0,10),
      purchaser:((at.profile&&at.profile.name)||"").trim(),
      email, phone:((at.profile&&at.profile.cell_phone)||"").trim(),
      timeslot:"", ticket:"", emails:new Set(), attendees:[]});
    const fam=orders.get(oid);
    fam.emails.add(email.toLowerCase());
    // Ticket-class name often carries the chosen time slot (e.g. "11 AM–12 PM").
    if(!fam.ticket && (at.ticket_class_name||"").trim()) fam.ticket=(at.ticket_class_name).trim();
    fam.attendees.push(attendeeToChild(at));
  }
  return [...orders.values()];
}
async function discoverEvents(token){
  // Find the "Free Event at We Rock the Spectrum Kids Gym" event. It runs at
  // three times, which on Eventbrite may be three separate listings or three
  // ticket classes on one listing, so collect ALL matching ids.
  const wrtsIds=[], candidates=[];
  try{
    const me=await ebGet(`/users/me/organizations/`, token);
    for(const org of me.organizations||[]){
      let page=1, pages=1;
      do{
        // status:"all" so already-passed events are still returned.
        const d=await ebGet(`/organizations/${org.id}/events/`, token, {order_by:"created_desc",status:"all",page});
        for(const ev of d.events||[]){
          const name=((ev.name&&ev.name.text)||"");
          const n=name.toLowerCase();
          candidates.push({id:ev.id, name, status:ev.status, start:(ev.start&&ev.start.local)||""});
          // Match any listing that names the gym / "we rock the spectrum".
          if(n.includes("we rock") || n.includes("rock the spectrum") || n.includes("spectrum kids gym")) wrtsIds.push(ev.id);
        }
        pages=d.pagination?d.pagination.page_count:1;
      } while(page++<pages && page<=20);
    }
  }catch(e){}
  return {wrtsIds, candidates};
}
// Human-readable time-slot label for a single event listing (e.g. its start).
function slotLabel(info){
  const s=(info&&info.start)||"";
  const m=s.match(/T(\d{2}):(\d{2})/);
  let time="";
  if(m){ let h=+m[1]; const ap=h>=12?"PM":"AM"; h=h%12||12; time=`${h}:${m[2].padStart(2,"0")} ${ap}`; }
  const day=s.slice(0,10);
  if(day && time) return `${day} · ${time}`;
  return (info&&info.name)||day||"";
}
async function eventInfo(id, token){
  try{ const e=await ebGet(`/events/${id}/`, token);
    return {id, name:(e.name&&e.name.text)||"", start:(e.start&&e.start.local)||""}; }
  catch(_){ return {id, name:"", start:""}; }
}
// Build the full events payload (shared by the dashboard API and the reminder mailer).
export async function getEvents(token){
  const envList=v=>v?String(v).split(",").map(s=>s.trim()).filter(Boolean):null;
  const {wrtsIds, candidates}=await discoverEvents(token);
  // Env override wins; otherwise use everything discovered by name plus the
  // known listing id(s), de-duplicated, so the event always shows up.
  const wrtsList=envList(process.env.EVENT_WRTS)||[...new Set([...wrtsIds, ...DEFAULT_WRTS_IDS])];
  if(!wrtsList.length) throw new Error("No matching events found for this token.");

  // "Free Event at We Rock the Spectrum Kids Gym." The three times may be three
  // separate Eventbrite listings OR three ticket classes on one listing, so tag
  // each registration by its ticket-class name when present, otherwise by the
  // listing's start time. A listing we can't read is skipped, not fatal.
  let wrtsFams=[], wrtsRawCount=0;
  for(const id of wrtsList){
    try{
      const info=await eventInfo(id, token);
      const startSlot=slotLabel(info);
      const raw=await allAttendees(id, token);
      wrtsRawCount+=raw.length;
      const fams=buildFamilies(raw).map(f=>{ const t=f.ticket; delete f.emails;
        return {...f, confirmed:null, count:f.attendees.length, timeslot:(t||startSlot), eventId:id}; });
      wrtsFams=wrtsFams.concat(fams);
    }catch(_){ /* skip a listing we can't read (bad id / no access) */ }
  }
  // Distinct time slots actually present (handles both the multi-listing and
  // the single-listing-with-ticket-classes cases).
  const wrtsSlots=[]; const seenS=new Set();
  for(const f of wrtsFams){ const s=(f.timeslot||"").trim(); if(s && !seenS.has(s)){ seenS.add(s); wrtsSlots.push(s); } }
  // Union of every question asked across the event (first-seen order) so the
  // dashboard can render all questions dynamically and aggregate results.
  const wrtsQuestions=[]; const seenQ=new Set();
  for(const f of wrtsFams) for(const at of f.attendees) for(const {q} of (at.qa||[])){
    if(q && !seenQ.has(q)){ seenQ.add(q); wrtsQuestions.push(q); }
  }

  const events=[];
  if(wrtsFams.length) events.push({key:"wrts",name:"We Rock the Spectrum",
    venue:"Free Event · We Rock the Spectrum Kids Gym",
    hasConfirm:false, dynamic:true, questions:wrtsQuestions,
    slots:wrtsSlots, families:wrtsFams});
  const out={events};
  return {out, dbg:{
    wrtsIds:wrtsList,
    wrtsAttendeesFetched:wrtsRawCount, wrtsFamilies:wrtsFams.length,
    wrtsQuestions:wrtsQuestions.length, wrtsSlots,
    candidates
  }};
}

export default async function handler(req,res){
  const debug = req.query && req.query.debug;
  const token = process.env.EVENTBRITE_TOKEN;
  if(!token) return res.status(200).json(meta(null,false,"No EVENTBRITE_TOKEN set yet.",debug));
  try{
    const {out, dbg}=await getEvents(token);
    res.setHeader("Cache-Control","s-maxage=30, stale-while-revalidate=60");
    return res.status(200).json(meta(out,true,null,debug,dbg));
  }catch(err){
    return res.status(200).json(meta(null,false,String(err&&err.message||err),debug,{}));
  }
}
function meta(data,live,message,debug,extra){
  const base = data&&data.events ? data : {events:[]};
  const m={live,message:message||null};
  if(debug) m.debug=extra||{};
  return {...base,_meta:m};
}
