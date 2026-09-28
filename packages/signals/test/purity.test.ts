import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The tsconfig already hides I/O types from signal extraction. These are the escape hatches it
// can't hide: the clock and randomness live in the ES standard library itself.
const FORBIDDEN: ReadonlyArray<[string, RegExp]> = [
  ["the clock", /\bDate\b|\bperformance\b/],
  ["randomness", /\bMath\.random\b|\bcrypto\b/],
  ["I/O", /\bfetch\b|\bsetTimeout\b|\bsetInterval\b|\bconsole\b|\bprocess\b|\bglobalThis\b/],
];

const src = join(import.meta.dirname, "../src");
const withoutComments = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

describe("signal extraction stays pure", () => {
  const files = readdirSync(src).filter((file) => file.endsWith(".ts"));

  it("has source files to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)("%s reads no clock, randomness or I/O", (file) => {
    const code = withoutComments(readFileSync(join(src, file), "utf8"));
    for (const [what, pattern] of FORBIDDEN) {
      expect(code, `${file} touches ${what}`).not.toMatch(pattern);
    }
  });
});
