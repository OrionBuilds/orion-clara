// Read-only smoke for the model-based brief: composes today's model (calendar, mail, peers, OS)
// and prints the counts + the head of the HTML. Sends nothing, writes only the vault/model files.
//   node --experimental-transform-types --import ./scripts/test/register.mjs scripts/test/brief-model-smoke.ts
import { composeBriefModel, renderBriefHtml, briefSubject, renderBriefSpoken } from "../../src/lib/clara/briefModel";
const m = await composeBriefModel();
console.log("subject:", briefSubject(m));
console.log("counts:", JSON.stringify(m.counts), "| meetings today:", m.meetings.today.length, "| tomorrowAm:", m.meetings.tomorrowAm.length, "| prep:", m.prep.length, "| waiting:", m.waiting.length, "| team:", m.team.friday.actions.length, "| drain:", JSON.stringify({ f: m.drain?.friday.length, own: m.drain?.own.length }));
console.log("--- spoken ---"); console.log(renderBriefSpoken(m));
console.log("--- html head ---"); console.log(renderBriefHtml(m).split("\n").slice(0, 40).join("\n"));
process.exit(0);
