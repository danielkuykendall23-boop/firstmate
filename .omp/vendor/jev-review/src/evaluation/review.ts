import { reviewInputSchema, toJevState, type ReviewInput } from "./input.js";
import { buildJevQuestions } from "./questions.js";
import { toEvaluation } from "./transform.js";
import type { Evaluation } from "./types.js";
import { getJevApiKey } from "../config/environment.js";
import { JevClient } from "../jev/client.js";

export type ReviewDependencies = {
  apiKey?: string;
  client?: Pick<JevClient, "evaluate">;
};

export async function reviewWithJev(
  rawInput: ReviewInput,
  dependencies: ReviewDependencies = {}
): Promise<Evaluation> {
  const input = reviewInputSchema.parse(rawInput);
  const client = dependencies.client ?? new JevClient({
    apiKey: dependencies.apiKey ?? getJevApiKey()
  });
  const response = await client.evaluate(toJevState(input), buildJevQuestions());
  return toEvaluation(response, input.previousEvaluation);
}
