// Deterministic transport partner, not an AI review. Exercises the real task
// tool, reviewer discovery/restrictions, extension binding and tool results.
function evaluation(value) {
  if (value && typeof value === "object") {
    if (value.metrics?.correctness) return value;
    for (const part of Object.values(value)) { const found = evaluation(part); if (found) return found; }
  }
  if (typeof value === "string") {
    try { return evaluation(JSON.parse(value)); } catch { /* Tool text may have a display prefix. */ }
    const start = value.indexOf('{"metrics"');
    if (start >= 0) { try { return evaluation(JSON.parse(value.slice(start, value.lastIndexOf("}") + 1))); } catch {} }
  }
}

export function reviewerModel(evidence) {
  return (request, res) => {
    const tools = (request.tools ?? []).map((tool) => tool.function?.name ?? tool.name);
    const system = request.messages.filter((message) => message.role === "system" || message.role === "developer").map((message) => JSON.stringify(message.content)).join("\n");
    const child = system.includes("Find bugs author wants fixed before merge");
    const results = request.messages.filter((message) => message.role === "tool");
    let call, text;
    if (child) {
      evidence.childTools = tools;
      const scored = results.map((result) => evaluation(result.content)).find(Boolean);
      const absent = !tools.includes("jev_review");
      if (!absent && !scored && !results.length) call = { name: "jev_review", arguments: { task: "Verify the new key gate is inert without a key", diff: "+ if (!apiKey) return;" } };
      else if (!absent && !scored) { text = "Reviewer tool failed: " + JSON.stringify(results); evidence.childError = text; }
      else {
        if (scored) evidence.childEvaluation = scored;
        const yielded = request.messages.flatMap((message) => message.tool_calls ?? []).filter((call) => call.function?.name === "yield").length;
        const sections = [
          ["jev_evaluation", scored ?? { unavailable: true, reason: "jev_review tool absent" }],
          ["overall_correctness", "correct"],
          ["explanation", scored
            ? `Synthetic transport proof: correctness ${scored.metrics.correctness.score}/10, confidence ${scored.metrics.correctness.confidence}; scores do not authorize a merge.`
            : "Synthetic transport proof: Jev unavailable; ordinary agent-led review continued without claiming Jev ran."],
          ["confidence", 0.91],
        ];
        if (yielded < sections.length) call = { name: "yield", arguments: { type: [sections[yielded][0]], data: sections[yielded][1] } };
        else text = "Review proof complete.";
      }
    } else if (!results.length) call = { name: "task", arguments: {
      context: "Credential-free integration proof. Use reviewer, no edits, no tests or builds.",
      tasks: [{ agent: "reviewer", task: "Review the synthetic key gate with jev_review and return metric scores and confidence. Do not edit or run tests, builds or formatters." }],
    } };
    else { text = "Parent received reviewer result: " + results.map((result) => result.content).join("\n"); evidence.parentResult = text; }
    if (call && !tools.includes(call.name)) { evidence.missingTool = { child, wanted: call.name, tools }; text = "Required tool unavailable: " + call.name; call = undefined; }
    res.setHeader("content-type", "text/event-stream");
    const delta = call ? { role: "assistant", tool_calls: [{ index: 0, id: `proof-${request.messages.length}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] } : { role: "assistant", content: text };
    const frame = (delta, finish_reason) => ({ id: "synthetic-completion", object: "chat.completion.chunk", created: 1, model: "proof", choices: [{ index: 0, delta, finish_reason }] });
    res.write(`data: ${JSON.stringify(frame(delta, null))}\n\n`);
    res.write(`data: ${JSON.stringify(frame({}, call ? "tool_calls" : "stop"))}\n\n`);
    res.end("data: [DONE]\n\n");
  };
}
