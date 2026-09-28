import { describe, expect, it } from "vitest";
import { responseTextOf } from "../src/inference/workers-ai";

const VERDICT = '{"verdict":"phishing","confidence":0.9,"evidence":["password_field"],"reasoning":"x"}';

describe("responseTextOf", () => {
  it("takes the response field, which is what most Workers AI models return", () => {
    expect(responseTextOf({ response: VERDICT })).toBe(VERDICT);
  });

  it("unwraps an OpenAI-style chat completion, which several models return instead", () => {
    const envelope = {
      id: "chatcmpl-abc",
      object: "chat.completion",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: VERDICT } }],
    };
    expect(responseTextOf(envelope)).toBe(VERDICT);
  });

  it("prefers the response field when a model sends both", () => {
    const both = { response: VERDICT, choices: [{ message: { content: "something else" } }] };
    expect(responseTextOf(both)).toBe(VERDICT);
  });

  it("passes an already-parsed object straight through, as JSON mode sometimes returns one", () => {
    const parsed = { verdict: "uncertain", confidence: 0.4, evidence: [], reasoning: "x" };
    expect(responseTextOf({ response: parsed })).toBe(parsed);
  });

  it.each([
    ["an empty choices list", { choices: [] }],
    ["a choice with no message", { choices: [{ finish_reason: "length" }] }],
    ["neither shape", { id: "chatcmpl-abc", object: "chat.completion" }],
  ])("hands back %s unchanged, so the adapter rejects it and records what arrived", (_what, result) => {
    expect(responseTextOf(result)).toBe(result);
  });
});
