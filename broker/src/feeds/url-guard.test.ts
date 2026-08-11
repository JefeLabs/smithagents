import assert from "node:assert/strict";
import { test } from "node:test";
import { urlRejectionReason } from "./url-guard.ts";

test("an ordinary public feed is fetchable", () => {
  assert.equal(urlRejectionReason("https://github.com/spring-projects/spring-boot/releases.atom"), null);
  assert.equal(urlRejectionReason("http://example.test/rss"), null);
});

test("cloud metadata is refused — the SSRF target that matters most", () => {
  assert.match(urlRejectionReason("http://169.254.169.254/latest/meta-data/")!, /private or loopback/);
});

test("loopback and the private ranges are refused", () => {
  for (const url of [
    "http://localhost:3000/work/boards",
    "http://127.0.0.1:7790/agents",
    "http://10.0.0.5/x",
    "http://192.168.1.10/x",
    "http://172.16.4.4/x",
    "http://[::1]/x",
  ]) {
    assert.match(urlRejectionReason(url) ?? "", /private or loopback/, url);
  }
});

test("public addresses adjacent to private ranges still pass", () => {
  assert.equal(urlRejectionReason("http://172.32.0.1/x"), null, "172.32 is public");
  assert.equal(urlRejectionReason("http://11.0.0.1/x"), null, "11.x is public");
});

test("non-http protocols are refused", () => {
  assert.match(urlRejectionReason("file:///etc/passwd")!, /only http and https/);
  assert.match(urlRejectionReason("data:text/plain,hi")!, /only http and https/);
});

test("nonsense is refused rather than thrown", () => {
  assert.match(urlRejectionReason("not a url")!, /not a valid URL/);
  assert.match(urlRejectionReason("")!, /not a valid URL/);
});
