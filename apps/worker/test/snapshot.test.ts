import { describe, expect, it } from "vitest";
import { fetchSnapshot, MAX_SNAPSHOT_BYTES } from "../src/snapshot";

/** A stand-in for the network, so these tests never leave the machine. */
const serving = (
  body: string,
  init: { status?: number; type?: string; location?: string } = {},
): typeof fetch =>
  (async () => {
    const headers = new Headers({ "content-type": init.type ?? "text/html; charset=utf-8" });
    if (init.location) headers.set("location", init.location);
    return new Response(init.status && init.status >= 300 && init.status < 400 ? null : body, {
      status: init.status ?? 200,
      headers,
    });
  }) as unknown as typeof fetch;

const PAGE = "<html><body><h1>Hello</h1></body></html>";

describe("fetchSnapshot", () => {
  it("fetches a page and hands back its source", async () => {
    const result = await fetchSnapshot("https://example.com/login", { fetcher: serving(PAGE) });

    expect(result).toEqual({ ok: true, html: PAGE, finalUrl: "https://example.com/login" });
  });

  it.each([
    ["http, which would send the request in the clear", "http://example.com/"],
    ["a scheme that isn't the web at all", "file:///etc/passwd"],
    ["something that isn't a URL", "not a url"],
  ])("refuses %s", async (_what, url) => {
    const result = await fetchSnapshot(url, { fetcher: serving(PAGE) });
    expect(result).toMatchObject({ ok: false, reason: "unsupported_url" });
  });

  it("allows a URL naming this very Worker, which is not an attempt to reach somewhere private", async () => {
    const result = await fetchSnapshot("http://localhost:8788/corpus/pages/x/source", {
      fetcher: serving(PAGE, { type: "text/plain" }),
      selfOrigin: "http://localhost:8788",
    });

    expect(result).toMatchObject({ ok: true, html: PAGE });
  });

  it("allows only that origin, not anything else on the same machine", async () => {
    // https, so this can only fail on the host check — proving the exception is the origin
    // and not a general amnesty for localhost.
    const result = await fetchSnapshot("https://localhost:9999/admin", {
      fetcher: serving(PAGE),
      selfOrigin: "http://localhost:8788",
    });

    expect(result).toMatchObject({ ok: false, reason: "not_public" });
  });

  it.each([
    ["loopback", "https://127.0.0.1/admin"],
    ["localhost by name", "https://localhost/admin"],
    ["a private range", "https://192.168.1.1/"],
    ["link-local metadata", "https://169.254.169.254/latest/meta-data/"],
    ["another private range", "https://10.0.0.5/"],
  ])("refuses %s, so a supplied URL can't be aimed inwards", async (_what, url) => {
    const result = await fetchSnapshot(url, { fetcher: serving(PAGE) });
    expect(result).toMatchObject({ ok: false, reason: "not_public" });
  });

  it("refuses credentials in the URL, which would be sent to whatever it resolves to", async () => {
    const result = await fetchSnapshot("https://user:secret@example.com/", { fetcher: serving(PAGE) });
    expect(result).toMatchObject({ ok: false, reason: "unsupported_url" });
  });

  it("follows a redirect and reports where it ended up, since that is what was judged", async () => {
    let call = 0;
    const fetcher = (async (input: RequestInfo) => {
      call++;
      const url = String(input);
      if (url.endsWith("/start")) {
        return new Response(null, { status: 302, headers: { location: "https://example.com/end" } });
      }
      return new Response(PAGE, { status: 200, headers: { "content-type": "text/html" } });
    }) as unknown as typeof fetch;

    const result = await fetchSnapshot("https://example.com/start", { fetcher });

    expect(result).toEqual({ ok: true, html: PAGE, finalUrl: "https://example.com/end" });
    expect(call).toBe(2);
  });

  it("refuses a redirect that turns inwards part-way", async () => {
    const fetcher = (async () =>
      new Response(null, { status: 302, headers: { location: "https://169.254.169.254/" } })) as unknown as typeof fetch;

    const result = await fetchSnapshot("https://example.com/start", { fetcher });
    expect(result).toMatchObject({ ok: false, reason: "not_public" });
  });

  it("gives up rather than following a redirect loop", async () => {
    const fetcher = (async () =>
      new Response(null, { status: 302, headers: { location: "https://example.com/again" } })) as unknown as typeof fetch;

    const result = await fetchSnapshot("https://example.com/start", { fetcher });
    expect(result).toMatchObject({ ok: false, reason: "too_many_redirects" });
  });

  it("refuses anything that isn't a web page, so it never reads a binary as markup", async () => {
    const result = await fetchSnapshot("https://example.com/f.pdf", {
      fetcher: serving("%PDF-1.4", { type: "application/pdf" }),
    });
    expect(result).toMatchObject({ ok: false, reason: "not_html" });
  });

  it("truncates an oversized page rather than pulling the whole thing into memory", async () => {
    const huge = "x".repeat(MAX_SNAPSHOT_BYTES * 2);
    const result = await fetchSnapshot("https://example.com/", { fetcher: serving(huge) });

    expect(result.ok).toBe(true);
    expect(result.ok && result.html.length).toBeLessThanOrEqual(MAX_SNAPSHOT_BYTES);
  });

  it("reports a page that wouldn't load, rather than throwing", async () => {
    const fetcher = (async () => {
      throw new Error("dns failure");
    }) as unknown as typeof fetch;

    const result = await fetchSnapshot("https://nowhere.example/", { fetcher });
    expect(result).toMatchObject({ ok: false, reason: "unreachable" });
  });

  it("reports an error status, since an error page is not the page that was reported", async () => {
    const result = await fetchSnapshot("https://example.com/", { fetcher: serving("nope", { status: 404 }) });
    expect(result).toMatchObject({ ok: false, reason: "http_404" });
  });
});
