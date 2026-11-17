// Clara — local embeddings via LM Studio. Thin wrapper resolving Clara's own base URL/model
// config and calling the shared embed()/cosine() in @autom8ionlab/agent-core (the
// module both FRIDAY and Clara used to duplicate locally — see git history for the pre-shared-lib
// fork and why the original cross-project path alias to FRIDAY's copy didn't work under Turbopack).

import { embed as sharedEmbed, cosine } from "@autom8ionlab/agent-core";
import { lmStudioBaseUrl, lmStudioEmbedModel } from "./lmstudio";

export async function embed(texts: string[]): Promise<number[][]> {
  const baseUrl = await lmStudioBaseUrl();
  const model = await lmStudioEmbedModel();
  return sharedEmbed(texts, { baseUrl, model });
}

export { cosine };
