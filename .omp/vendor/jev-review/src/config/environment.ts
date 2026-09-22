import { JevApiError } from "../jev/client.js";

export function getJevApiKey(environment: NodeJS.ProcessEnv = process.env): string {
  const apiKey = environment.JEV_API_KEY?.trim();
  if (!apiKey) {
    throw new JevApiError("JEV_API_KEY is not set. Export it before starting your coding agent.");
  }
  return apiKey;
}
