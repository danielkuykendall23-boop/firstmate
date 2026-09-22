// Local protocol fixture only: known synthetic responses, never model judgment.
import { createServer } from "node:http";

export function systemOneResponse(request, score = 3) {
  const answers = {};
  for (const [id, question] of Object.entries(request.questions)) {
    if (question.type === "noul") answers[id] = { type: "noul", noul: id.endsWith("_applicable") || id.endsWith("_t1") ? 0.95 : 0.05 };
    else if (question.type === "score") answers[id] = {
      type: "score", score, confidence: 0.91,
      legend: Object.fromEntries(question.criteria.map((label, index) => [String(index), label])),
      probabilities: { [score]: 1 },
    };
    else if (question.type === "choice") {
      const choice = Object.keys(question.criteria).find((key) => key !== "no_material_issue");
      answers[id] = { type: "choice", choice, probabilities: { [choice]: 1 }, confidence: 0.91 };
    } else throw new Error(`Unsupported synthetic question type: ${question.type}`);
  }
  return { model: "jev-latest", answers, usage: { input_tokens: 1, output_tokens: 1 } };
}

export async function fakeSystemOne({ marker = "", handleModel } = {}) {
  const evidence = { hits: 0, markerLeaked: false, questions: 0, states: [], modelRequests: [] };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", async () => {
      try {
        const parsed = JSON.parse(body);
        if (parsed.messages && handleModel) {
          evidence.modelRequests.push(parsed);
          await handleModel(parsed, res);
          return;
        }
        evidence.hits++;
        evidence.markerLeaked ||= Boolean(marker && body.includes(marker));
        evidence.questions += Object.keys(parsed.questions).length;
        evidence.states.push(parsed.state);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(systemOneResponse(parsed, String(parsed.state?.task).includes("RESCORE") ? 8 : 3)));
      } catch (error) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: error.message }));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, evidence, url: `http://127.0.0.1:${server.address().port}/v1/systemone` };
}
