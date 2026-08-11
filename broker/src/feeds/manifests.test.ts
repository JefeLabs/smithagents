import assert from "node:assert/strict";
import { test } from "node:test";
import { readManifests } from "./manifests.ts";

function io(files: Record<string, string>) {
  return { read: (p: string) => files[p] ?? null };
}

test("package.json yields DIRECT dependencies only — never devDependencies", () => {
  const deps = readManifests(
    io({
      "/repo/package.json": JSON.stringify({
        dependencies: { react: "^19.0.0", vite: "5.2.0" },
        devDependencies: { vitest: "^4.0.0" },
      }),
    }),
    "/repo",
  );
  assert.deepEqual(deps.map((d) => d.name).sort(), ["react", "vite"]);
  assert.equal(
    deps.every((d) => d.eco === "npm"),
    true,
  );
  assert.equal(deps.find((d) => d.name === "react")!.version, "19.0.0", "range markers stripped");
});

test("build.gradle yields group:artifact coordinates", () => {
  const deps = readManifests(
    io({ "/repo/build.gradle": `dependencies {\n  implementation 'org.springframework.boot:spring-boot:4.0.0'\n}` }),
    "/repo",
  );
  assert.deepEqual(deps, [
    { name: "org.springframework.boot:spring-boot", eco: "maven", version: "4.0.0", manifest: "build.gradle" },
  ]);
});

test("pom.xml yields group:artifact coordinates", () => {
  const deps = readManifests(
    io({
      "/repo/pom.xml": `<project><dependencies><dependency>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot</artifactId>
        <version>4.0.0</version>
      </dependency></dependencies></project>`,
    }),
    "/repo",
  );
  assert.equal(deps[0]!.name, "org.springframework.boot:spring-boot");
  assert.equal(deps[0]!.eco, "maven");
});

test("Cargo.toml yields crates, in both the short and table forms", () => {
  const deps = readManifests(
    io({
      "/repo/Cargo.toml": `[dependencies]\ntauri = "2.0.0"\nserde = { version = "1.0.200", features = ["derive"] }\n`,
    }),
    "/repo",
  );
  assert.deepEqual(deps.map((d) => `${d.name}@${d.version}`).sort(), ["serde@1.0.200", "tauri@2.0.0"]);
});

test("several manifests in one repo all contribute", () => {
  const deps = readManifests(
    io({
      "/repo/package.json": JSON.stringify({ dependencies: { react: "19.0.0" } }),
      "/repo/Cargo.toml": `[dependencies]\ntauri = "2.0.0"\n`,
    }),
    "/repo",
  );
  assert.equal(deps.length, 2);
});

test("no manifests, or unreadable ones, yield nothing rather than throwing", () => {
  assert.deepEqual(readManifests(io({}), "/repo"), []);
  assert.deepEqual(readManifests(io({ "/repo/package.json": "{not json" }), "/repo"), []);
});
