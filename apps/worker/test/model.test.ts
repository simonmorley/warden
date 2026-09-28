import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { modelFor } from "../src/model";

describe("modelFor", () => {
  it("builds a model from the Worker's own bindings", () => {
    expect(modelFor(env)?.id).toBe(env.MODEL_ID);
  });

  it.each([
    ["no AI binding", { MODEL_ID: "@cf/some/model" }],
    ["no model id", { AI: {} }],
    ["neither", {}],
  ])("has no model when there is %s, so nothing silently classifies with the wrong one", (_what, bindings) => {
    expect(modelFor(bindings as unknown as Env)).toBeNull();
  });
});
