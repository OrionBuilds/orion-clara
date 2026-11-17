// Receives {access_token, refresh_token} from the client-side capture page (the tokens arrive in a
// URL fragment that never reaches the server, so the browser forwards them here). captureSession
// verifies the identity via Supabase /auth/v1/user before persisting to Clara's vault.
//
// Two vaults, one callback: `target: "agent"` (set by the /os/auth/agent flow) persists the
// session as Clara's clara@ AGENT identity (~/.agentic-os/clara/agent, used only by the OS
// agent-task poller); otherwise it's the owner's owner session as before. The agent path refuses any
// account other than clara@ so a mis-clicked Google account can't silently become the poll
// identity — the schedules are keyed to clara@'s user id, so anything else would poll zero rows.
import { promises as fs } from "node:fs";
import { osAuth } from "@/lib/clara/osClient";
import { osAgentAuth, OS_AGENT_SESSION_FILE } from "@/lib/clara/osAgentClient";

export const runtime = "nodejs";

const AGENT_EMAIL = (process.env.CLARA_OS_AGENT_EMAIL ?? "clara@example.com").toLowerCase();

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    target?: string;
  };
  if (!body.access_token || !body.refresh_token) {
    return Response.json({ ok: false, error: "missing access_token/refresh_token" }, { status: 400 });
  }
  const auth = body.target === "agent" ? osAgentAuth : osAuth;
  const res = await auth.captureSession(body.access_token, body.refresh_token);
  if (res.ok && body.target === "agent" && res.email?.toLowerCase() !== AGENT_EMAIL) {
    // Wrong Google account for the agent vault. captureSession verifies-then-writes, so the bad
    // session is already on disk — delete it, or osAgentEnabled() would flip true and the poller
    // would start polling as the wrong user (finding zero schedules, silently).
    await fs.rm(OS_AGENT_SESSION_FILE, { force: true }).catch(() => {});
    return Response.json(
      { ok: false, error: `agent sign-in must be ${AGENT_EMAIL}, got ${res.email ?? "unknown"} — the session was discarded; re-run /os/auth/agent signed in as the clara@ account` },
      { status: 400 },
    );
  }
  return Response.json(res, { status: res.ok ? 200 : 400 });
}

export async function GET() {
  return Response.json({
    configured: osAuth.osConfigured(),
    identity: osAuth.osIdentity(),
    agent: { configured: osAgentAuth.osConfigured(), identity: osAgentAuth.osIdentity() },
  });
}
