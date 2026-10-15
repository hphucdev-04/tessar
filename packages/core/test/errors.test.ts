import { expect, it } from "vitest";
import { errorInfo, TesseractError } from "../src/errors.js";

it("retains the provider origin and SDK fields across outer catches", () => {
  const error = Object.assign(new Error("Rate limited"), {
    name: "RateLimitError", code: "rate_limit_exceeded", status: 429,
    request_id: "request-1",
  });
  expect(errorInfo(error, { source: "provider", providerId: "openai", modelId: "x" }))
    .toMatchObject({ source: "provider", providerId: "openai", modelId: "x",
      name: "RateLimitError", code: "rate_limit_exceeded", message: "Rate limited",
      details: { status: 429, request_id: "request-1" } });
  expect(errorInfo(error).source).toBe("provider");
});

it("identifies framework errors and plain core exceptions without an unknown source", () => {
  expect(new TesseractError("ThreadBusy", "Busy").toJSON()).toMatchObject({ source: "tesseract", code: "ThreadBusy" });
  expect(errorInfo(new TypeError("Core bug"))).toMatchObject({ source: "tesseract", name: "TypeError", code: "TypeError" });
});
