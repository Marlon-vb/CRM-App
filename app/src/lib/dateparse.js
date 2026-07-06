/* Natural-language due-date parsing for the Todo add box.

   parseDuePhrase("Send the deck Friday")
     -> { task: "Send the deck", dueDate: "2026-05-22" }
   parseDuePhrase("Call Marco")
     -> { task: "Call Marco", dueDate: null }

   Client-side only — instant, no backend round-trip. Recognises a date
   phrase at the END of the input (the natural place people put it) and
   strips it, optionally preceded by "by" / "on" / "due". Dates resolve
   against the local "today", always leaning into the future. */

const WEEKDAYS = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
  sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6,
};
const MONTHS = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
  jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
};

// Longest alternatives first so the regex anchors don't mis-bind
const DOW = "sunday|monday|tuesday|wednesday|thursday|friday|saturday|tues|thurs|thur|sun|mon|tue|wed|thu|fri|sat";
const MON = "january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec";
const PREP = "(?:by\\s+|on\\s+|due\\s+(?:on\\s+)?)?";

const pad = (n) => String(n).padStart(2, "0");
const toISO = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

// Pick the year that puts month/day today or in the future
function inferYear(mon, day) {
  const t = startOfToday();
  let year = t.getFullYear();
  if (new Date(year, mon, day) < t) year += 1;
  return year;
}

const PATTERNS = [
  { re: new RegExp(`\\s+${PREP}(today|tonight)\\s*$`, "i"),
    resolve: () => startOfToday() },
  { re: new RegExp(`\\s+${PREP}(tomorrow|tmrw|tmr)\\s*$`, "i"),
    resolve: () => addDays(startOfToday(), 1) },
  { re: /\s+in\s+(\d{1,3})\s+days?\s*$/i,
    resolve: (m) => addDays(startOfToday(), parseInt(m[1], 10)) },
  { re: /\s+in\s+a\s+week\s*$/i,
    resolve: () => addDays(startOfToday(), 7) },
  { re: /\s+next\s+week\s*$/i,
    resolve: () => {
      const t = startOfToday();
      return addDays(t, ((1 - t.getDay() + 7) % 7) || 7);   // next Monday
    } },
  { re: new RegExp(`\\s+next\\s+(${DOW})\\s*$`, "i"),
    resolve: (m) => {
      const t = startOfToday();
      const near = (WEEKDAYS[m[1].toLowerCase()] - t.getDay() + 7) % 7;
      return addDays(t, near === 0 ? 7 : near + 7);
    } },
  { re: /\s+(?:this\s+)?weekend\s*$/i,
    resolve: () => {
      const t = startOfToday();
      return addDays(t, (6 - t.getDay() + 7) % 7);          // upcoming Saturday
    } },
  { re: /\s+this\s+week\s*$/i,
    resolve: () => {
      const t = startOfToday();
      return addDays(t, (5 - t.getDay() + 7) % 7);          // upcoming Friday
    } },
  { re: new RegExp(`\\s+${PREP}(${DOW})\\s*$`, "i"),
    resolve: (m) => {
      const t = startOfToday();
      return addDays(t, (WEEKDAYS[m[1].toLowerCase()] - t.getDay() + 7) % 7);
    } },
  // "23 May" / "23rd May" / "23 May 2026"
  { re: new RegExp(`\\s+${PREP}(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MON})(?:\\s+(\\d{4}))?\\s*$`, "i"),
    resolve: (m) => {
      const day = parseInt(m[1], 10);
      const mon = MONTHS[m[2].toLowerCase()];
      if (day < 1 || day > 31) return null;
      return new Date(m[3] ? parseInt(m[3], 10) : inferYear(mon, day), mon, day);
    } },
  // "May 23" / "May 23 2026"
  { re: new RegExp(`\\s+${PREP}(${MON})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+(\\d{4}))?\\s*$`, "i"),
    resolve: (m) => {
      const mon = MONTHS[m[1].toLowerCase()];
      const day = parseInt(m[2], 10);
      if (day < 1 || day > 31) return null;
      return new Date(m[3] ? parseInt(m[3], 10) : inferYear(mon, day), mon, day);
    } },
  // "23/5", "23/05", "23/5/26" — day/month order (European, matches Marlon)
  { re: new RegExp(`\\s+${PREP}(\\d{1,2})\\/(\\d{1,2})(?:\\/(\\d{2,4}))?\\s*$`, "i"),
    resolve: (m) => {
      const day = parseInt(m[1], 10);
      const mon = parseInt(m[2], 10) - 1;
      if (day < 1 || day > 31 || mon < 0 || mon > 11) return null;
      let year = m[3] ? parseInt(m[3], 10) : inferYear(mon, day);
      if (year < 100) year += 2000;
      return new Date(year, mon, day);
    } },
];

export function parseDuePhrase(input) {
  const raw = (input || "").trim();
  if (!raw) return { task: "", dueDate: null };
  for (const { re, resolve } of PATTERNS) {
    const m = raw.match(re);
    if (!m) continue;
    const d = resolve(m);
    if (!d || Number.isNaN(d.getTime())) continue;
    const task = raw.slice(0, m.index).trim();
    if (!task) continue;            // don't swallow a bare date that has no task
    return { task, dueDate: toISO(d) };
  }
  return { task: raw, dueDate: null };
}
