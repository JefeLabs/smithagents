import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_IDENTITY, loadIdentity, promptInfo } from "./identity.ts";

test("a full identity file wins over every default", () => {
  const id = loadIdentity(() =>
    JSON.stringify({
      id: "smith",
      name: "Smith",
      role: "Concierge",
      avatarRing: "#123456",
      persona: { style: "Clipped." },
      backstory: "Was a program.",
      voice: { voiceId: "v-1" },
      quickAnswers: { name: "Smith." },
    }),
  );
  assert.equal(id.name, "Smith");
  assert.equal(id.role, "Concierge");
  assert.equal(id.avatarRing, "#123456");
  assert.equal(id.persona.style, "Clipped.");
  assert.equal(id.voice.voiceId, "v-1");
  assert.equal(id.quickAnswers?.name, "Smith.");
});

test("a partial file keeps defaults for what it omits", () => {
  const id = loadIdentity(() => JSON.stringify({ name: "Smith" }));
  assert.equal(id.name, "Smith");
  assert.equal(id.role, DEFAULT_IDENTITY.role);
  assert.equal(id.avatarRing, DEFAULT_IDENTITY.avatarRing);
  assert.equal(id.persona.style, DEFAULT_IDENTITY.persona.style);
});

test("unreadable file falls back to the built-in Anderson", () => {
  const id = loadIdentity(() => {
    throw new Error("ENOENT");
  });
  assert.equal(id.name, "Anderson");
  assert.equal(id, DEFAULT_IDENTITY);
});

test("malformed JSON and non-string name both fall back", () => {
  assert.equal(loadIdentity(() => "{nope").name, "Anderson");
  assert.equal(loadIdentity(() => JSON.stringify({ name: 42 })).name, "Anderson");
});

test("promptInfo extracts exactly what the brain prompt needs", () => {
  const info = promptInfo(DEFAULT_IDENTITY);
  assert.deepEqual(info, {
    name: DEFAULT_IDENTITY.name,
    role: DEFAULT_IDENTITY.role,
    style: DEFAULT_IDENTITY.persona.style,
  });
});
