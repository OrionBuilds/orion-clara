// Clara — deal pipeline id-resolution and the (approval-gated) deal-write client.
//
// HISTORY, because the boundary moved deliberately and twice. 2026-08-03 gave Clara the
// opportunities family READ-ONLY (see agent-core allowlists.ts): deal *writes* were FRIDAY's, and
// intent.ts carried a comment explaining why create_deal/move_deal_stage were deliberately absent —
// "a tool that needs an id it cannot obtain is a tool that fails on first use", and Clara had no
// pipelines_list/stages_list to resolve a pipeline_id/stage_id from a name. The master plan's
// Phase 5 CLARA bullet resolves both halves at once: build the id-resolution reads, and use them to
// unblock the two writes. This module is that build.
//
// WHY A SECOND OsMcpClient. osClient.ts's client is allow-listed to CLARA_OS_TOOLS, which lives in
// agent-core (agent-core) as the shared single source of truth for the native client AND the
// spawned-CLI `--allowedTools` list. This tranche needs exactly three tools beyond it —
// pipelines_list (reads pipelines WITH nested stages, so no separate stages call is needed),
// opportunities_create, opportunities_update — and agent-core is not this change's territory (other
// agents build against it in parallel, and editing it forces a package rebuild). So the extension
// lives here, visibly, as its own client:
//
//   · The CLI path is deliberately NOT widened. CLARA_OS_CLI_TOOLS derives from CLARA_OS_TOOLS,
//     which is untouched — a free-reasoning `claude -p` still cannot create or move a deal. The
//     only route to these writes is the two intent tools, and both are reversible:false, so every
//     single call rides the intent.tool approval rail to the owner first.
//   · PENDING (flagged for the allowlist owner): fold DEAL_TOOL_EXTENSION into CLARA_OS_TOOLS in
//     agent-core/src/osmcp/allowlists.ts next time agent-core is open, updating its 2026-08-03
//     "READ-ONLY" comment to cite the Phase 5 decision, then delete the extension here. Keep
//     opportunities_delete excluded everywhere — see the reverse-gear note below.
//
// REVERSE GEAR (§7.4). move_deal_stage's reverse is itself: move the deal back to the stage it
// came from (opportunity_stage_history_list records every hop, and the tool's result line names
// the prior stage). create_deal has NO exposed reverse — opportunities_delete exists server-side
// but is deliberately not granted to Clara (hard deletes stay off her surface, same policy as
// drive.delete being trash-only); the documented undo path is opportunity_close(status:"lost") or
// The owner deleting the row in the OS UI. That asymmetry is exactly why both writes are approval-gated
// rather than auto.
//
// KNOWN SERVER-SIDE GAP (pending, written but NOT applied): opportunities.created_by is NOT NULL
// with no default, and mcp-server's opportunities_create schema does not accept created_by — so an
// approved create_deal will fail with a NOT NULL violation until the migration
// orion/supabase/migrations/20260814000000_default_opportunities_created_by.sql (drafted alongside
// this file) is applied. The tool surfaces the API error honestly when that happens; nothing is
// half-created because the insert is a single statement.

import { OsMcpClient, allowExact, CLARA_OS_TOOLS } from "@autom8ionlab/agent-core";
import { osAuth } from "./osClient";

/** The three tools this tranche needs beyond CLARA_OS_TOOLS. Exact names, mirrored from
 *  mcp-server/src/tools/opportunities.ts. Deliberately NOT including opportunities_delete. */
export const DEAL_TOOL_EXTENSION: readonly string[] = [
  "pipelines_list",        // read: pipelines with nested stages — the id-resolution path
  "opportunities_create",  // write: gated behind create_deal (reversible:false → approval)
  "opportunities_update",  // write: gated behind move_deal_stage (reversible:false → approval)
];

// Same auth vault, same per-call connect-and-close lifecycle as osClient — OsMcpClient holds no
// long-lived session, so a second instance costs nothing while idle.
const dealsClient = new OsMcpClient({
  auth: osAuth,
  url: process.env.ORION_MCP_URL,
  allow: allowExact([...CLARA_OS_TOOLS, ...DEAL_TOOL_EXTENSION]),
  clientName: "clara-osmcp-deals",
});

/** Call an OS tool through the deals client (allowlist = CLARA_OS_TOOLS + DEAL_TOOL_EXTENSION). */
export async function dealsCallTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  return dealsClient.callTool(name, args);
}

// MCP tool results arrive as [{type:"text", text:"<json>"}] — same unwrap intent.ts uses privately.
// Exported (as unwrapToolResult) for the e-signature tools, which call the OS rail directly.
export function unwrapToolResult(content: unknown): unknown {
  return unwrap(content);
}
function unwrap(content: unknown): unknown {
  if (Array.isArray(content)) {
    const first = content.find((c) => c && typeof c === "object" && "text" in (c as object));
    if (first && typeof (first as { text?: unknown }).text === "string") {
      try { return JSON.parse((first as { text: string }).text); } catch { return (first as { text: string }).text; }
    }
  }
  return content;
}

export interface PipelineStage {
  id: string;
  name: string;
  sort_order?: number;
  probability?: number;
}

export interface Pipeline {
  id: string;
  name: string;
  org_id?: string;
  stages: PipelineStage[];
}

/** All pipelines with their stages, stages sorted by board order. One MCP call. */
export async function listPipelines(): Promise<Pipeline[]> {
  const rows = unwrap(await dealsCallTool("pipelines_list", {}));
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => {
    const p = r as { id?: unknown; name?: unknown; org_id?: unknown; stages?: unknown };
    const stages = (Array.isArray(p.stages) ? p.stages : [])
      .map((st) => {
        const x = st as { id?: unknown; name?: unknown; sort_order?: unknown; probability?: unknown };
        return {
          id: String(x.id ?? ""),
          name: String(x.name ?? ""),
          // PostgREST numeric-as-string trap (see pipeline_status): coerce, don't typeof-check.
          sort_order: Number.isFinite(Number(x.sort_order)) ? Number(x.sort_order) : undefined,
          probability: Number.isFinite(Number(x.probability)) ? Number(x.probability) : undefined,
        };
      })
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
    return { id: String(p.id ?? ""), name: String(p.name ?? ""), org_id: p.org_id ? String(p.org_id) : undefined, stages };
  });
}

export type Resolved =
  | { ok: true; pipeline: Pipeline; stage: PipelineStage }
  | { ok: false; error: string };

/**
 * Resolve a pipeline + stage from ids or names. Case-insensitive on names; exact on ids. A stage
 * must belong to the resolved pipeline — this is the "id it cannot obtain" fix and the guard that
 * makes create_deal/move_deal_stage fail loudly at the queue-side read instead of writing a deal
 * into a stage from the wrong board.
 */
export async function resolvePipelineStage(pipelineRef: string, stageRef: string): Promise<Resolved> {
  const pipelines = await listPipelines();
  if (!pipelines.length) return { ok: false, error: "the CRM has no pipelines configured" };

  const pRef = pipelineRef.trim().toLowerCase();
  const pipeline = pipelines.find((p) => p.id === pipelineRef.trim())
    ?? pipelines.find((p) => p.name.toLowerCase() === pRef)
    ?? (pipelines.length === 1 && !pRef ? pipelines[0] : undefined);
  if (!pipeline) {
    return { ok: false, error: `no pipeline matching "${pipelineRef}" — pipelines are: ${pipelines.map((p) => `${p.name} [${p.id}]`).join(", ")}` };
  }

  const sRef = stageRef.trim().toLowerCase();
  const stage = pipeline.stages.find((st) => st.id === stageRef.trim())
    ?? pipeline.stages.find((st) => st.name.toLowerCase() === sRef);
  if (!stage) {
    return {
      ok: false,
      error: `pipeline "${pipeline.name}" has no stage matching "${stageRef}" — its stages are: ${pipeline.stages.map((st) => `${st.name} [${st.id}]`).join(", ") || "(none)"}`,
    };
  }
  return { ok: true, pipeline, stage };
}
