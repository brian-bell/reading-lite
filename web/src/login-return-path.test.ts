import { afterEach, describe, expect, it } from "vitest";

import {
  consumeLoginReturnPath,
  loginNextStorageKey,
  rememberLoginReturnPath,
  safeReadingReturnPath
} from "./login-return-path";

describe("safeReadingReturnPath", () => {
  it("allows a same-app reading detail path", () => {
    expect(safeReadingReturnPath("/readings/rd_ONE")).toBe("/readings/rd_ONE");
  });

  it("rejects open redirects", () => {
    expect(safeReadingReturnPath("https://evil.example/phish")).toBeUndefined();
    expect(safeReadingReturnPath("//evil.example")).toBeUndefined();
    expect(safeReadingReturnPath("/login")).toBeUndefined();
    expect(safeReadingReturnPath("/readings/rd_ONE@evil.example")).toBeUndefined();
    expect(safeReadingReturnPath("/readings/rd_ONE?next=https://evil.example")).toBeUndefined();
    expect(safeReadingReturnPath("/readings/%2f%2fevil.example")).toBeUndefined();
  });
});

describe("login return path storage", () => {
  afterEach(() => {
    sessionStorage.clear();
  });

  it("remembers only a safe next and consumes it once", () => {
    rememberLoginReturnPath("https://evil.example");
    expect(sessionStorage.getItem(loginNextStorageKey)).toBeNull();
    rememberLoginReturnPath("/readings/rd_ONE");
    expect(consumeLoginReturnPath(null)).toBe("/readings/rd_ONE");
    expect(consumeLoginReturnPath(null)).toBe("/");
  });

  it("prefers a safe query next over storage", () => {
    rememberLoginReturnPath("/readings/rd_STORED");
    expect(consumeLoginReturnPath("/readings/rd_QUERY")).toBe("/readings/rd_QUERY");
    expect(sessionStorage.getItem(loginNextStorageKey)).toBeNull();
  });
});
