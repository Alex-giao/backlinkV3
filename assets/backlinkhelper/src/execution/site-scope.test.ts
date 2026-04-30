import test from "node:test";
import assert from "node:assert/strict";

import { safeSameSiteSiblingNavigation, siteDomainForHostname } from "./site-scope.js";

test("siteDomainForHostname uses PSL/private-domain boundaries for sibling matching", () => {
  assert.equal(siteDomainForHostname("forums.pioneerdj.com"), "pioneerdj.com");
  assert.equal(siteDomainForHostname("www.pioneerdj.com"), "pioneerdj.com");
  assert.equal(siteDomainForHostname("forums.example.co.uk"), "example.co.uk");
  assert.equal(siteDomainForHostname("victim.github.io"), "victim.github.io");
  assert.equal(siteDomainForHostname("attacker.github.io"), "attacker.github.io");
});

test("safeSameSiteSiblingNavigation keeps real brand sibling signup links", () => {
  assert.equal(
    safeSameSiteSiblingNavigation({
      currentUrl: "https://forums.pioneerdj.com/hc/en-us/community/posts/28657611549337-topic",
      candidateUrl: "https://www.pioneerdj.com/en/account/register/",
    }),
    true,
  );
});

test("safeSameSiteSiblingNavigation rejects private-suffix tenant crossing and http downgrade", () => {
  assert.equal(
    safeSameSiteSiblingNavigation({
      currentUrl: "https://victim.github.io/community/thread",
      candidateUrl: "https://attacker.github.io/register",
    }),
    false,
  );
  assert.equal(
    safeSameSiteSiblingNavigation({
      currentUrl: "https://forums.example.com/thread",
      candidateUrl: "http://www.example.com/account/register/",
    }),
    false,
  );
});

test("safeSameSiteSiblingNavigation rejects known multi-tenant support and cleartext source pages", () => {
  assert.equal(
    safeSameSiteSiblingNavigation({
      currentUrl: "https://company.zendesk.com/hc/en-us/community/posts/123-topic",
      candidateUrl: "https://attacker.zendesk.com/register",
    }),
    false,
  );
  assert.equal(
    safeSameSiteSiblingNavigation({
      currentUrl: "http://forums.example.com/thread",
      candidateUrl: "https://www.example.com/account/register/",
    }),
    false,
  );
});
