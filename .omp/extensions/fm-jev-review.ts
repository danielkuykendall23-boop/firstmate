// In-process pinned upstream evaluation; no MCP process or global key export.
// OMP's injected pi.zod owns the public tool schema. The bundled evaluator
// carries upstream Zod, which bare imports cannot resolve in OMP 18.2.8.
// No LSP is configured here; strict typechecking and real OMP execution cover it.
import { fileURLToPath } from "node:url";
import { JevApiError, JevClient, JevEvaluationError, reviewWithJev } from "../vendor/jev-review/dist/review.js";
import type { ReviewInput } from "../vendor/jev-review/src/evaluation/input.ts";
import type { Evaluation } from "../vendor/jev-review/src/evaluation/types.ts";
import { resolveTypesafeKey } from "./lib/fm-jev-key.ts";
import { hideSecretsState } from "./lib/fm-jev-privacy.ts";
import { registrations } from "./lib/fm-jev-registration.ts";

// Minimal structural surface, as in the other Firstmate OMP extensions.
type Schema = { optional(): Schema };
type Builder = {
  string(): Schema;
  unknown(): Schema;
  record(key: Schema, value: Schema): Schema;
  array(value: Schema): Schema;
  object(shape: Record<string, Schema>): Schema;
};
type Context = { cwd?: string; ui?: { notify?(text: string, kind?: string): void } };
type Unavailable = { unavailable: true; reason: string };
type Result = { content: { type: "text"; text: string }[]; details: Evaluation | Unavailable; isError?: boolean };
type ExtensionAPI = {
  events: object;
  zod: Builder;
  registerTool(tool: {
    name: string; label: string; description: string; loadMode: "essential"; approval: "read";
    parameters: Schema;
    execute(id: string, input: ReviewInput, signal?: AbortSignal, onUpdate?: unknown, ctx?: Context): Promise<Result>;
  }): void;
};
const extensionFile = fileURLToPath(import.meta.url);

function unavailable(reason: string, ctx?: Context): Result {
  const text = `Jev review unavailable: ${reason}; continue agent-led review without Jev.`;
  ctx?.ui?.notify?.(text, "warning");
  return { content: [{ type: "text", text }], details: { unavailable: true, reason }, isError: true };
}

export default function (pi: ExtensionAPI): void {
  if (!resolveTypesafeKey(extensionFile)) return;
  const loaded = registrations("fm-jev-review");
  if (loaded.has(pi.events)) return;
  const z = pi.zod;
  pi.registerTool({
    name: "jev_review",
    label: "Jev Review",
    description: "Evaluate focused task context and code with Jev; return dimension scores, confidence, priorities and local deltas. Supply task, diff or files. Scores inform agent diagnosis, never pass/merge authority. Send no secrets: with native Hide Secrets enabled or unprovable this tool refuses; when disabled it does not add a secret scanner.",
    loadMode: "essential",
    approval: "read",
    parameters: z.object({
      task: z.string().optional(),
      diff: z.string().optional(),
      files: z.array(z.object({ path: z.string(), content: z.string() })).optional(),
      repositoryContext: z.string().optional(),
      previousEvaluation: z.record(z.string(), z.unknown()).optional(),
    }),
    async execute(_id, input, signal, _onUpdate, ctx) {
      if (!input.task?.trim() && !input.diff?.trim() && !input.files?.length) return unavailable("supply task, diff or files", ctx);
      if (signal?.aborted) return unavailable("cancelled", ctx);
      const protection = hideSecretsState(ctx?.cwd ?? process.cwd());
      if (protection.state !== "off") return unavailable(protection.state === "on"
        ? "OMP Hide Secrets is on; evaluation would receive unredacted input"
        : "OMP Hide Secrets could not be established", ctx);
      const apiKey = resolveTypesafeKey(extensionFile);
      if (!apiKey) return unavailable("TYPESAFE_API_KEY absent", ctx);
      const client = new JevClient({
        apiKey,
        fetchImplementation: (url, init) => fetch(process.env.FM_JEV_ENDPOINT || url, {
          ...init,
          signal: signal ? AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]) : init?.signal,
        }),
      });
      try {
        const evaluation = await reviewWithJev(input, { client });
        return { content: [{ type: "text", text: JSON.stringify(evaluation) }], details: evaluation };
      } catch (error) {
        // Validation errors may echo input; never emit their messages or raw bodies.
        const reason = signal?.aborted ? "cancelled"
          : error instanceof JevApiError ? (error.status ? `Jev HTTP ${error.status}` : "Jev network or response failure")
          : error instanceof JevEvaluationError ? "Jev omitted a required evaluation answer"
          : "invalid review input or evaluation result";
        return unavailable(reason, ctx);
      }
    },
  });
  loaded.add(pi.events);
}
