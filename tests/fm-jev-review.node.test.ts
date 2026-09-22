import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import registerReview from "../.omp/extensions/fm-jev-review.ts";
import { JevClient, reviewWithJev } from "../.omp/vendor/jev-review/dist/review.js";
import { systemOneResponse } from "./fixtures/fake-systemone.mjs";

type API = Parameters<typeof registerReview>[0];
type Tool = Parameters<API["registerTool"]>[0];
// Registration mechanics are unit fixtures; real schema consumption and child
// tool availability are checked by the installed OMP live regression.
const shape = { optional() { return this; } };
const schema = { string: () => shape, unknown: () => shape, record: () => shape, array: () => shape, object: () => shape };
const lab = mkdtempSync(join(tmpdir(), "fm-jev-review-"));
const fakeOmp = join(lab, "omp");
writeFileSync(fakeOmp, '#!/bin/sh\nprintf \'{"key":"secrets.enabled","value":%s}\\n\' "${FAKE_SECRETS:-false}"\n');
chmodSync(fakeOmp, 0o755);

async function environment(fn: () => Promise<void>) {
  const saved = { ...process.env }, execPath = Object.getOwnPropertyDescriptor(process, "execPath")!, argv = process.argv;
  process.env.FM_HOME = lab;
  process.env.TYPESAFE_API_KEY = "fake-review-key";
  process.env.FAKE_SECRETS = "false";
  process.argv = [fakeOmp];
  Object.defineProperty(process, "execPath", { value: fakeOmp, configurable: true });
  try { await fn(); } finally {
    Object.defineProperty(process, "execPath", execPath); process.argv = argv;
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

function load(events = {}) {
  const tools: Tool[] = [];
  const api = { events, zod: schema, registerTool: (tool: Tool) => tools.push(tool) };
  registerReview(api);
  return { tools, api };
}

test("upstream scores drive priorities and local rescore deltas without resubmitting earlier evaluations", async () => {
  const sent: unknown[] = [];
  let score = 3;
  const client = new JevClient({ apiKey: "fake", fetchImplementation: async (_url, init) => {
    const request = JSON.parse(String(init?.body)); sent.push(request.state);
    return new Response(JSON.stringify(systemOneResponse(request, score)), { status: 200 });
  } });
  const baseline = await reviewWithJev({ task: "Guard duplicate review registrations" }, { client });
  assert.equal(baseline.metrics.correctness.score, 4);
  assert.equal(baseline.metrics.security.confidence, 0.91);
  assert.ok(baseline.priorities.some((priority) => priority.metric === "correctness"));
  score = 8;
  const after = await reviewWithJev({ task: "Guard duplicate review registrations", previousEvaluation: baseline }, { client });
  assert.equal(after.metrics.correctness.score, 9);
  assert.deepEqual(after.comparison?.find((entry) => entry.metric === "correctness"), { metric: "correctness", previousScore: 4, currentScore: 9, delta: 5, direction: "improved" });
  assert.equal(after.priorities.length, 0);
  assert.equal(baseline.metrics.correctness.score, 4);
  assert.deepEqual(sent[1], { task: "Guard duplicate review registrations" });
});

test("review is absent without a key and registers once per session, including child sessions", async () => environment(async () => {
  delete process.env.TYPESAFE_API_KEY;
  const first = load(); assert.equal(first.tools.length, 0);
  process.env.TYPESAFE_API_KEY = "fake";
  registerReview(first.api); registerReview({ ...first.api });
  assert.equal(first.tools.length, 1);
  assert.equal(load({}).tools.length, 1);
}));

test("review refuses protected, unprovable and context-only submissions without network traffic", async () => environment(async () => {
  const saved = globalThis.fetch;
  let hits = 0;
  globalThis.fetch = async () => { hits++; throw new Error("must not send"); };
  try {
    const tool = load().tools[0];
    const contextOnly = await tool.execute("empty", { repositoryContext: "not a task" });
    assert.equal(contextOnly.isError, true);
    process.env.FAKE_SECRETS = "true";
    const protectedResult = await tool.execute("protected", { task: "SYNTHETIC_SECRET_MUST_STAY_LOCAL" });
    assert.match(protectedResult.content[0].text, /Hide Secrets is on/);
    process.env.FAKE_SECRETS = "null";
    const unknown = await tool.execute("unknown", { task: "SYNTHETIC_SECRET_MUST_STAY_LOCAL" });
    assert.match(unknown.content[0].text, /could not be established/);
    assert.equal(hits, 0);
  } finally { globalThis.fetch = saved; }
}));

test("tool exposes meaningful evaluation and sanitized errors, never fake success on bad responses", async () => environment(async () => {
  const saved = globalThis.fetch;
  let broken = false;
  globalThis.fetch = async (_url, init) => new Response(JSON.stringify(broken ? { secret: "NEVER_PRINT_ME" } : systemOneResponse(JSON.parse(String(init?.body)))), { status: 200 });
  try {
    const tool = load().tools[0];
    const result = await tool.execute("good", { task: "Review scope" });
    assert.deepEqual(JSON.parse(result.content[0].text), result.details);
    assert.equal("metrics" in result.details && result.details.metrics.correctness.score, 4);
    broken = true;
    const error = await tool.execute("bad", { task: "Review scope" });
    assert.equal(error.isError, true);
    assert.match(error.content[0].text, /continue agent-led review without Jev/);
    assert.doesNotMatch(error.content[0].text, /NEVER_PRINT_ME|fake-review-key/);
  } finally { globalThis.fetch = saved; }
}));
