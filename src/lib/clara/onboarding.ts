// Clara — guided onboarding for the owner (3-5 sessions). Business-only: Clara is an
// executive assistant for business tasks. Writes a structured profile to vault/contacts/.

import { promises as fs } from "node:fs";
import path from "node:path";
import { loadConfig } from "./config";
import type { PrincipalId } from "./types";
import { OWNER_NAME } from "./owner";

export interface Question {
  id: string;
  text: string;
  category: "identity" | "work" | "preferences" | "vips" | "health" | "logistics" | "vendors";
  session: 1 | 2 | 3 | 4 | 5;
}

export interface Answer {
  qid: string;
  text: string;
  ts: string;
}

export const OWNER_QUESTIONS: Question[] = [
  // Session 1 — identity & orbit
  { id: "s1-1",  session: 1, category: "identity",   text: "What do you want me to call you day-to-day? Any nicknames I should know about?" },
  { id: "s1-2",  session: 1, category: "identity",   text: "What's your birthday? Any work milestones or dates I should track (company founding, key anniversaries)?" },
  { id: "s1-5",  session: 1, category: "logistics",  text: "Your office / base address and cell number — for context when I'm arranging things." },

  // Session 2 — work
  { id: "s2-1",  session: 2, category: "work",       text: "Walk me through your businesses / roles. What are the hats you wear, and who reports to whom?" },
  { id: "s2-2",  session: 2, category: "work",       text: "Who are your VIPs at work — investors, board, key clients, top team? Emails and phones if you have them." },
  { id: "s2-3",  session: 2, category: "work",       text: "What are your standing meetings and their cadence?" },
  { id: "s2-4",  session: 2, category: "work",       text: "What time do you want to be in focus mode by default? Any days that are protected?" },

  // Session 3 — preferences (the small stuff that makes me great)
  { id: "s3-1",  session: 3, category: "preferences",text: "Coffee order. Restaurant vibes you love vs won't tolerate. Any food allergies or hard nos?" },
  { id: "s3-2",  session: 3, category: "preferences",text: "Airline / seat / hotel brand preferences and any loyalty numbers." },
  { id: "s3-3",  session: 3, category: "preferences",text: "Communication style — brief bullets? Full context? When should I use voice vs text?" },

  // Session 4 — health & routine
  { id: "s4-1",  session: 4, category: "health",     text: "Any health conditions, allergies, or meds I should be aware of for scheduling and travel?" },
  { id: "s4-3",  session: 4, category: "health",     text: "Workout / routine you want me to help protect — mornings, evenings, days off?" },

  // Session 5 — vendors, VIPs, and the miscellany
  { id: "s5-1",  session: 5, category: "vendors",    text: "Business vendors you've used and either loved or hated — office services, contractors, caterers, IT, printers." },
  { id: "s5-2",  session: 5, category: "vips",       text: "Business VIPs — clients and partners I should always get through, and folks you owe reach-outs to." },
  { id: "s5-3",  session: 5, category: "logistics",  text: "Office security / access setup — alarm co, building access, gate or door codes, key vendors on file." },
  { id: "s5-4",  session: 5, category: "logistics",  text: "Business emergency contacts — who's the escalation chain if I can't reach you? IT, building management, key deputies." },
];

async function profilePath(principal: PrincipalId): Promise<string> {
  const cfg = await loadConfig();
  const dir = path.join(cfg.vaultRoot, "contacts");
  await fs.mkdir(dir, { recursive: true });
  return path.join(dir, `${principal}.md`);
}

export async function recordAnswer(principal: PrincipalId, a: Answer, q: Question): Promise<void> {
  const p = await profilePath(principal);
  const existing = await fs.readFile(p, "utf8").catch(() => "");
  const header = existing ? "" : `# ${OWNER_NAME}\n\n_Compiled from onboarding by Clara._\n\n`;
  const block = `\n## ${q.category} — session ${q.session}\n**Q:** ${q.text}\n**A:** ${a.text}\n_recorded ${a.ts}_\n`;
  await fs.writeFile(p, header + existing + block, "utf8");
}

export async function progress(principal: PrincipalId): Promise<{ answered: string[]; nextSession: number }> {
  const p = await profilePath(principal);
  const md = await fs.readFile(p, "utf8").catch(() => "");
  const answered = OWNER_QUESTIONS.filter((q) => md.includes(q.text)).map((q) => q.id);
  const sessionsDone = new Set(OWNER_QUESTIONS.filter((q) => answered.includes(q.id)).map((q) => q.session));
  const nextSession = [1, 2, 3, 4, 5].find((s) => !sessionsDone.has(s as 1 | 2 | 3 | 4 | 5)) ?? 6;
  return { answered, nextSession };
}

export function sessionQuestions(session: 1 | 2 | 3 | 4 | 5): Question[] {
  return OWNER_QUESTIONS.filter((q) => q.session === session);
}
