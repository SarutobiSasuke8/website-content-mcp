import assert from "node:assert/strict";
import test from "node:test";

import { assertPublicHttpUrl, isPublicAddress } from "../src/network-policy.js";

void test("public-address policy blocks local, private, link-local and metadata-style ranges", () => {
  for (const address of [
    "127.0.0.1",
    "10.0.0.7",
    "169.254.169.254",
    "172.16.1.1",
    "192.168.1.1",
    "::1",
    "fe80::1",
    "fd00::1",
  ]) {
    assert.equal(isPublicAddress(address), false, address);
  }
  assert.equal(isPublicAddress("93.184.216.34"), true);
  assert.equal(isPublicAddress("2606:2800:220:1:248:1893:25c8:1946"), true);
});

void test("URL policy rejects an allowed hostname when DNS resolves privately", async () => {
  await assert.rejects(
    () => assertPublicHttpUrl(
      "https://site.test/page",
      () => Promise.resolve([{ address: "169.254.169.254", family: 4 }]),
    ),
    /private or special-use/u,
  );
});

void test("URL policy accepts a hostname only when all resolved addresses are public", async () => {
  await assert.doesNotReject(
    () => assertPublicHttpUrl(
      "https://site.test/page",
      () => Promise.resolve([
        { address: "93.184.216.34", family: 4 },
        { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
      ]),
    ),
  );
});
