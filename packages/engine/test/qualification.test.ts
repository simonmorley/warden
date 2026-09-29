import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, initialPermission, qualify, standing, type Permission } from "../src/index";

const policy = DEFAULT_POLICY;
const shadow = (right: number, wrong: number): Permission => ({ ...initialPermission(), right, wrong });

describe("qualify", () => {
  it("says not yet with no evidence, rather than ruling anything in or out", () => {
    expect(qualify(0, 0, policy)).toBe("not_yet");
  });

  it("clears the bar where the lower bound does, and not a call before", () => {
    expect(qualify(72, 0, policy)).toBe("not_yet");
    expect(qualify(73, 0, policy)).toBe("clears");
  });

  it("calls a 90% record unqualifiable at around 80 calls, and not yet before that", () => {
    expect(qualify(63, 7, policy)).toBe("not_yet");
    expect(qualify(72, 8, policy)).toBe("unqualifiable");
  });

  // Unqualifiable is a statement about the evidence so far, not a sentence passed for good.
  it("lets a record that was unqualifiable come back, if what follows is good enough", () => {
    expect(qualify(72, 8, policy)).toBe("unqualifiable");
    expect(qualify(172, 8, policy)).toBe("not_yet");
  });

  it("is decided by the policy's bar, not a fixed one", () => {
    expect(qualify(72, 8, { ...policy, requiredScore: 0.9 })).toBe("not_yet");
    expect(qualify(72, 8, { ...policy, requiredScore: 0.8 })).toBe("clears");
  });
});

describe("standing", () => {
  it("reports a SHADOW record that can't reach the bar as UNQUALIFIABLE", () => {
    expect(standing(shadow(72, 8), policy)).toBe("UNQUALIFIABLE");
  });

  it("leaves SHADOW as it is while the bar is still within reach", () => {
    expect(standing(shadow(0, 0), policy)).toBe("SHADOW");
    expect(standing(shadow(30, 0), policy)).toBe("SHADOW");
    expect(standing(shadow(63, 7), policy)).toBe("SHADOW");
  });

  it.each(["EARNING", "AUTONOMOUS"] as const)("leaves %s as it is: it only got there by clearing the bar", (state) => {
    expect(standing({ ...shadow(80, 0), state }, policy)).toBe(state);
  });
});
