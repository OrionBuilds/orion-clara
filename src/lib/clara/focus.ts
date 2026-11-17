// Clara — "is the owner in focus mode right now?"
//
// True if the current time overlaps a work-calendar event whose title marks it as a meeting,
// focus block, or Do-Not-Disturb slot. Cached briefly to keep webhook latency low.

import { listUpcoming } from "./ms-calendar";

let cached: { at: number; value: boolean } | null = null;
const TTL_MS = 30_000;

const FOCUS_HINT = /\bfocus\b|\bdeep work\b|\bdnd\b|\bdo not disturb\b|\bheads down\b/i;

export async function ownerFocusMode(now: Date = new Date()): Promise<boolean> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.value;

  const in3h = new Date(now.getTime() + 3 * 3600_000);
  let live = false;
  try {
    const events = await listUpcoming({ account: "work", timeMin: now.toISOString(), timeMax: in3h.toISOString(), max: 20 });
    for (const e of events) {
      const s = new Date(e.start).getTime();
      const eEnd = new Date(e.end).getTime();
      if (now.getTime() >= s && now.getTime() < eEnd) {
        // Any live meeting counts as focus. Focus/DND-tagged events also count.
        if ((e.attendees && e.attendees.length > 0) || FOCUS_HINT.test(e.summary)) {
          live = true;
          break;
        }
      }
    }
  } catch {
    // If Google isn't connected yet, we can't tell — default to NOT focus (calls ring through).
    live = false;
  }
  cached = { at: Date.now(), value: live };
  return live;
}
