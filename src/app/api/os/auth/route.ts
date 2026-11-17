// One-time interactive sign-in for Clara's orion (OS MCP) access.
//
// Sign in as clara@example.com — her own OS account, carrying the ClaraAgent role. NOT as
// The owner. She used to run on their identity, and the tell that a re-auth landed on the wrong account
// is that agent_heartbeats keeps recording polls under the owner's account instead of clara@.
//
// To re-mint the session (e.g. after an identity change): delete os-session.json from her agent
// directory (~/.agentic-os/clara), hit this route, and sign in as clara@.
//
// ── DO NOT SIGN OUT OF THAT BROWSER SESSION AFTERWARDS ────────────────────────────────────────
// What this captures is the refresh token OF THAT BROWSER SESSION. Supabase revokes it on sign-out,
// so signing clara@ out of the OS afterwards — even hours later, even to switch back to your own
// account — kills Clara's OS access. It fails exactly this way:
//
//   os-approvals: pull failed Error: orion token refresh 400:
//   {"error_code":"refresh_token_not_found","msg":"Invalid Refresh Token: Refresh Token Not Found"}
//
// and it is silent from the app's side: her health endpoint still returns 200, her process stays
// up, and only the OS polls stop. (Cost us four hours on 2026-08-01; the off-box liveness alarm is
// what caught it.)
//
// So do the sign-in in a PRIVATE/INCOGNITO window and just CLOSE it when the capture page says
// it's done. Closing a window does not revoke the session; signing out does. That also leaves your
// normal browser signed in as yourself, which is what you wanted anyway.
//
// ── CHANGING WHICH ACCOUNT SHE IS? REASSIGN HER SCHEDULES TOO ─────────────────────────────────
// claim_due_agent_task_runs() claims `WHERE agent_user_id = auth.uid()` — "mine only". So if the
// identity she signs in as stops matching `agent_task_schedules.agent_user_id`, she polls happily,
// claims nothing, and reports success while running no scheduled work at all. It is silent: the
// heartbeat still ticks, the poll still logs, the OS still looks green.
//
// That is exactly what the owner@ -> clara@ move caused on 2026-08-02 — 34 hours with six schedules
// overdue and zero runs. The fix is one UPDATE:
//
//   update agent_task_schedules set agent_user_id = '<new uid>'
//    where agent_slug = 'clara' and agent_user_id = '<old uid>';
//
// Sanity check afterwards, which should show each agent owning its own schedules:
//   select s.agent_slug, u.email, count(*) from agent_task_schedules s
//     join auth.users u on u.id = s.agent_user_id group by 1,2;
// GET /api/os/auth → bounce the browser to Supabase's Google OAuth. Supabase returns the session
// in the URL fragment to the capture page (src/app/os/auth/capture), which POSTs it to
// /api/os/auth/callback. After that the vault has Clara's OS refresh token and OS access is live.
import { osAuth } from "@/lib/clara/osClient";

export const runtime = "nodejs";

export async function GET() {
  return Response.redirect(osAuth.consentUrl(), 302);
}
