import { NextResponse } from "next/server";
import { ensureBootstrapped } from "@/lib/clara/bootstrap";
import { listPending } from "@/lib/clara/approvals";
import { listUnreadInbox } from "@/lib/clara/ms-mail";
import { classify } from "@/lib/clara/triage";
import { combinedUpcoming } from "@/lib/clara/ms-calendar";
import { listOpen as listOpenTasks } from "@/lib/clara/tasks";
import { readAll as readLedger } from "@/lib/clara/ledger";
import { healthReport } from "@/lib/clara/health";
import { promises as fs } from "node:fs";
import path from "node:path";
import { loadConfig } from "@/lib/clara/config";

export const runtime = "nodejs";

// One aggregated call for the Home dashboard — stat row, latest brief, integration status,
// and recent activity — instead of the page firing off half a dozen separate fetches.
export async function GET() {
  await ensureBootstrapped();

  const [approvals, tasks, health] = await Promise.all([
    listPending().catch(() => []),
    listOpenTasks().catch(() => []),
    healthReport().catch(() => null),
  ]);

  let vipMailCount = 0;
  try {
    const inbox = await listUnreadInbox(50);
    for (const m of inbox) {
      const v = await classify(m).catch(() => "escalate" as const);
      if (v === "vip") vipMailCount++;
    }
  } catch { /* Google not connected yet — leave at 0 */ }

  let todayEventCount = 0;
  try {
    const now = new Date();
    const startOfDay = new Date(now); startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(now); endOfDay.setHours(23, 59, 59, 999);
    const events = await combinedUpcoming(1);
    todayEventCount = events.filter((e) => {
      const t = new Date(e.start).getTime();
      return t >= startOfDay.getTime() && t <= endOfDay.getTime();
    }).length;
  } catch { /* Google not connected yet — leave at 0 */ }

  let latestBrief: { markdown: string; date: string } | null = null;
  try {
    const cfg = await loadConfig();
    const dir = path.join(cfg.vaultRoot, "briefs");
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith("-morning.md")).sort().reverse();
    if (files[0]) {
      const markdown = await fs.readFile(path.join(dir, files[0]), "utf8");
      latestBrief = { markdown, date: files[0].replace("-morning.md", "") };
    }
  } catch { /* none yet */ }

  const ledger = (await readLedger().catch(() => [])).slice(-8).reverse();

  return NextResponse.json({
    stats: {
      pendingApprovals: approvals.length,
      vipMail: vipMailCount,
      todayEvents: todayEventCount,
      openTasks: tasks.length,
    },
    latestBrief,
    health,
    activity: ledger,
  });
}
