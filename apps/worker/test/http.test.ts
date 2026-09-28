import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("HTTP surface", () => {
  it("serves the dashboard at /", async () => {
    const res = await SELF.fetch("https://warden.test/");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("<title>Warden</title>");
  });

  it("serves the dashboard under a strict Content-Security-Policy, since it displays attacker-written text", async () => {
    const res = await SELF.fetch("https://warden.test/");
    const csp = res.headers.get("content-security-policy") ?? "";

    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).not.toContain("unsafe-inline");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("answers an unknown path with a JSON 404, not an HTML page or a 500", async () => {
    const res = await SELF.fetch("https://warden.test/no-such-route");

    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ error: "not_found", message: expect.any(String) });
  });
});
