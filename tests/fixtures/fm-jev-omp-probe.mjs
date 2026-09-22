// Runs inside an isolated installed OMP, never the active Firstmate session.
import { join } from "node:path";

export default function (pi) {
  pi.registerCommand("jev-proof", {
    description: "Credential-free integration proof over synthetic data",
    handler: async (_args, ctx) => {
      const paths = [process.env.JEV_PROOF_ROOT, ctx.cwd].flatMap((root) => [
        join(root, ".omp/extensions/fm-jev-compaction.ts"),
        join(root, ".omp/extensions/fm-jev-review.ts"),
      ]);
      const loaded = await pi.pi.loadExtensions(paths, ctx.cwd);
      const tools = loaded.extensions.flatMap((ext) => [...ext.tools.values()]);
      const review = tools.find((tool) => tool.definition.name === "jev_review");
      const result = { errors: loaded.errors, tools: tools.map((tool) => tool.definition.name),
        hooks: loaded.extensions.reduce((count, ext) => count + (ext.handlers.get("session_before_compact")?.length ?? 0), 0),
        parentTools: pi.getAllTools().map((tool) => tool.name), keyExported: Boolean(process.env.TYPESAFE_API_KEY) };
      if (review) {
        const input = { task: "Preserve exact key gating for Firstmate Jev integration", diff: process.env.JEV_PROOF_DIFF || "+ if (!apiKey) return;" };
        result.baseline = await review.definition.execute("baseline", input, undefined, undefined, ctx);
        result.rescore = await review.definition.execute("rescore", { ...input, task: input.task + " RESCORE", previousEvaluation: result.baseline.details }, undefined, undefined, ctx);
      }
      ctx.ui.notify("JEV_PROOF=" + JSON.stringify(result), "info");
    },
  });
}
