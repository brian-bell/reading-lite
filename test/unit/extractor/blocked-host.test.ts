import { describe, expect, it } from "vitest";
import { isBlockedHost } from "../../../src/modules/extractor";

// Contract: takes a normalized hostname — lowercased, with any IPv6 brackets
// already stripped (assertSafeUrl does that normalization for URL callers).

const BLOCKED: Array<[string, string]> = [
  ["localhost", "localhost"],
  ["localhost.", "localhost with trailing dot"],
  ["printer.local", ".local mDNS"],
  ["printer.local.", ".local with trailing dot"],
  ["0.0.0.0", "this-network v4"],
  ["10.0.0.5", "RFC1918 10/8"],
  ["127.0.0.1", "loopback v4"],
  ["169.254.169.254", "link-local v4 (metadata endpoint)"],
  ["172.16.0.1", "RFC1918 172.16/12 lower bound"],
  ["172.31.255.255", "RFC1918 172.16/12 upper bound"],
  ["192.168.1.1", "RFC1918 192.168/16"],
  ["::", "unspecified v6"],
  ["::1", "loopback v6"],
  ["fc00::1", "ULA fc"],
  ["fd12:3456::1", "ULA fd"],
  ["fe80::1", "link-local v6"],
  ["::ffff:10.0.0.5", "v4-mapped dotted spelling"],
  ["::ffff:a00:5", "v4-mapped canonical hex spelling (10.0.0.5)"],
  ["100.64.0.1", "CGNAT/Tailscale 100.64/10 lower bound"],
  ["100.100.100.100", "CGNAT (Tailscale MagicDNS)"],
  ["100.127.255.255", "CGNAT/Tailscale 100.64/10 upper bound"],
  ["::ffff:100.64.0.1", "v4-mapped CGNAT"],
  ["192.0.0.1", "IETF protocol assignments 192.0.0.0/24"],
  ["198.18.0.1", "benchmarking 198.18/15"],
  ["198.19.255.255", "benchmarking 198.19 upper bound"],
  ["224.0.0.1", "multicast 224/4"],
  ["239.255.255.255", "multicast upper bound"],
  ["240.0.0.1", "reserved 240/4"],
  ["255.255.255.255", "broadcast"],
];

const ALLOWED: Array<[string, string]> = [
  ["example.com", "public hostname"],
  ["8.8.8.8", "public v4"],
  ["9.255.255.255", "just below 10/8"],
  ["11.0.0.1", "just above 10/8"],
  ["172.15.255.255", "just below 172.16/12"],
  ["172.32.0.1", "just above 172.16/12"],
  ["192.167.1.1", "just below 192.168/16"],
  ["100.63.255.255", "just below 100.64/10"],
  ["100.128.0.1", "just above 100.64/10"],
  ["192.0.1.1", "just above 192.0.0.0/24"],
  ["198.17.255.255", "just below 198.18/15"],
  ["198.20.0.1", "just above 198.18/15"],
  ["223.255.255.255", "just below multicast 224/4"],
  ["2606:4700::6810:84e5", "public v6"],
  ["::ffff:808:808", "v4-mapped public (8.8.8.8)"],
];

describe("isBlockedHost", () => {
  for (const [host, label] of BLOCKED) {
    it(`blocks ${label} (${host})`, () => {
      expect(isBlockedHost(host)).toBe(true);
    });
  }
  for (const [host, label] of ALLOWED) {
    it(`allows ${label} (${host})`, () => {
      expect(isBlockedHost(host)).toBe(false);
    });
  }
});
