import { describe, expect, it } from "vitest";

// @ts-expect-error CommonJS module without type definitions
import * as feedbackConfig from "../../native/feedback/config.cjs";

describe("feedback config module", () => {
  it("sends to the project host by default", () => {
    expect(feedbackConfig.DEFAULT_FEEDBACK_API).toBe("https://api.lenscli.com");
    expect(feedbackConfig.getFeedbackBaseUrl({})).toBe("https://api.lenscli.com");
  });

  it("prefers an explicit endpoint", () => {
    expect(
      feedbackConfig.getFeedbackBaseUrl({
        LENS_FEEDBACK_URL: "https://feedback.example.test",
      }),
    ).toBe("https://feedback.example.test");
  });

  it("treats an empty override as disabled", () => {
    expect(feedbackConfig.getFeedbackBaseUrl({ LENS_FEEDBACK_API: "" })).toBeNull();
  });
});
