import { test, expect } from "bun:test";
import { formatDuration, redactUrl, shortSha } from "../src/format.ts";

test("formatDuration: sub-minute uses one decimal second", () => {
  expect(formatDuration(1200)).toBe("1.2s");
  expect(formatDuration(23400)).toBe("23.4s");
  expect(formatDuration(500)).toBe("0.5s");
});

test("formatDuration: minute+ uses m + rounded s", () => {
  expect(formatDuration(72000)).toBe("1m12s");
  expect(formatDuration(65000)).toBe("1m5s");
  expect(formatDuration(60000)).toBe("1m0s");
  expect(formatDuration(3_725_000)).toBe("1h2m5s");
});

test("redactUrl hides credentials embedded in URLs", () => {
  expect(redactUrl("git clone https://oauth2:secret-token@codeup.aliyun.com/x.git /tmp/a")).toBe(
    "git clone https://***@codeup.aliyun.com/x.git /tmp/a",
  );
  expect(redactUrl("https://codeup.aliyun.com/x.git")).toBe("https://codeup.aliyun.com/x.git");
});

test("shortSha", () => {
  expect(shortSha("a1b2c3d4e5")).toBe("a1b2c3d");
  expect(shortSha(null)).toBe("");
});
