// Serves a downloadable .ics calendar file for the event, so "Add to calendar"
// works with Apple Calendar / Outlook desktop (not just Google's web link).
// GET /api/calendar-ics?slot=6:45%20PM

function icsEscape(s){ return String(s||"").replace(/([,;])/g,"\\$1").replace(/\n/g,"\\n"); }

// La Vista, NE is Central (CDT, UTC-5 in August). Build the UTC start for the
// family's slot, ending at the event close (8:00 PM CT = 01:00 UTC next day).
function startUTC(slot){
  const m = String(slot||"").match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if(!m) return "20260821T210000Z";
  let h = (+m[1]) % 12; if(/pm/i.test(m[3])) h += 12;
  const uh = String(h + 5).padStart(2,"0");
  return `20260821T${uh}${m[2]}00Z`;
}

export default function handler(req, res){
  const slot = (req.query && req.query.slot) || "";
  const dtStart = startUTC(slot);
  const dtEnd = "20260822T010000Z";
  const summary = "We Rock the Spectrum - Free Family Afternoon";
  const location = "We Rock the Spectrum Kids Gym, 10717 Virginia Plaza, Suite 113, La Vista, NE 68128";
  const desc = slot ? `Your reserved time is ${slot}. Pizza and door prizes!` : "Pizza and door prizes!";
  const uid = "wrts-2026-" + (slot||"family").replace(/[^a-z0-9]/gi,"") + "@updates.abtaba.com";
  const ics = [
    "BEGIN:VCALENDAR","VERSION:2.0","PRODID:-//Above and Beyond ABA//We Rock the Spectrum//EN","CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${dtStart}`,
    `DTSTART:${dtStart}`,
    `DTEND:${dtEnd}`,
    `SUMMARY:${icsEscape(summary)}`,
    `LOCATION:${icsEscape(location)}`,
    `DESCRIPTION:${icsEscape(desc)}`,
    "END:VEVENT","END:VCALENDAR"
  ].join("\r\n");
  res.setHeader("Content-Type", "text/calendar; charset=utf-8");
  res.setHeader("Content-Disposition", "attachment; filename=we-rock-the-spectrum.ics");
  return res.status(200).send(ics);
}
