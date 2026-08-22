import assert from "node:assert/strict";
import { test } from "node:test";
import { userAuthor } from "./git-author.js";

test("userAuthor: a user with an email is themselves", () => {
  assert.deepEqual(userAuthor({ id: "me", name: "Edwin Cruz", email: "e@example.com" } as never), {
    name: "Edwin Cruz",
    email: "e@example.com",
  });
});

test("userAuthor: no email → a deterministic address under users.smithagents, so blame still names a person", () => {
  assert.deepEqual(userAuthor({ id: "me", name: "Edwin Cruz" } as never), {
    name: "Edwin Cruz",
    email: "edwin-cruz@users.smithagents",
  });
});

test("userAuthor: no user at all → the tool itself, never a fabricated person", () => {
  assert.deepEqual(userAuthor(null), { name: "smithagents", email: "smithagents@localhost" });
});
