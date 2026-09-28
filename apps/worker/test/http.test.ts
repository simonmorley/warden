import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("HTTP surface", () => {
  it("serves the dashboard at /", async () => {
    const res = await SELF.fetch("https://warden.test/");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("<title>Warden</title>");
  });

  it("answers an unknown path with a JSON 404, not an HTML page or a 500", async () => {
    const res = await SELF.fetch("https://warden.test/no-such-route");

    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ error: "not_found", message: expect.any(String) });
  });
});
