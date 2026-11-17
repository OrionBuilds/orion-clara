// Clara — shared types.

// Executive-assistant-only (business): the owner is the only principal.
export type PrincipalId = "owner";

export interface Principal {
  id: PrincipalId;
  displayName: string;
  phones: string[];         // E.164
  emails: string[];
  authority: PrincipalId;   // whose tier table applies
}

export type ActionCategory =
  | "calendar.external"
  | "calendar.internal"
  | "email.work"
  | "email.personal"       // always blocked — personal Gmail excluded by policy
  | "travel.research"
  | "event.coordinate"
  | "sensitive.read"       // requires local LLM route
  | "call.outbound"
  | "call.business"        // outbound call to an external business — always draft-then-approve
  | "call.inbound"
  | "sms.send"
  | "drive.read"           // search + read anything in Drive
  | "drive.create"         // new files only — never touches anything that already exists
  | "drive.modify"         // edits an existing file — draft-then-approve
  | "drive.delete"         // trash (never permanent) — draft-then-approve
  | "drive.share"          // blocked by policy — the full drive scope can grant public access
  | "research.run"         // source-grounded research — reads the given sources and answers from them
  | "prospect.research"    // prospecting: plan/status/pause/resume/cancel/export — never spends on its own
  | "prospect.spend";      // prospecting: start a job / add budget — the plan's cost-table "go ahead" IS the confirmation

export type Posture = "auto" | "draft-then-approve" | "always-ask" | "blocked";

export interface TierRule {
  category: ActionCategory;
  posture: Posture;
  ceilingUsdPerTxn?: number;
  ceilingUsdPerDay?: number;
  note?: string;
}

export type Urgency = "emergency" | "urgent" | "normal" | "low";

export interface CallContext {
  fromE164: string;
  toE164: string;             // which of the owner's / Clara's numbers was dialed
  ownerFocusMode: boolean;    // is the owner in a focus block / meeting right now
  isWhitelisted: boolean;
}

export interface EngineHint {
  intent: "reasoning" | "drafting" | "classification" | "voice-response" | "sensitive";
  sensitive: boolean;         // hard-forces local-only routing
}
