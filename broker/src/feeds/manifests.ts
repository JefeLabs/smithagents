/**
 * Direct dependencies, from whichever manifests a repo happens to have
 * (spec §4.1). DIRECT only — a transitive tree would watch hundreds of
 * packages nobody chose.
 *
 * devDependencies are excluded on purpose: a test runner shipping a minor is
 * not news about your product.
 */
import type { Ecosystem } from "./versions.ts";

export interface Dependency {
  name: string;
  eco: Ecosystem;
  version: string;
  manifest: string;
}

/** `^19.0.0` / `~1.2` / `>=3` all reduce to the numeric core. */
function bareVersion(raw: string): string {
  return /(\d+\.\d+(?:\.\d+)?)/.exec(raw)?.[1] ?? "";
}

export function readManifests(io: { read(path: string): string | null }, repoPath: string): Dependency[] {
  const out: Dependency[] = [];
  const read = (name: string) => io.read(`${repoPath}/${name}`);

  const pkg = read("package.json");
  if (pkg) {
    try {
      const body = JSON.parse(pkg) as { dependencies?: Record<string, string> };
      for (const [name, range] of Object.entries(body.dependencies ?? {})) {
        out.push({ name, eco: "npm", version: bareVersion(range), manifest: "package.json" });
      }
    } catch {
      /* unreadable manifest contributes nothing */
    }
  }

  for (const file of ["build.gradle", "build.gradle.kts"]) {
    const gradle = read(file);
    if (!gradle) continue;
    for (const m of gradle.matchAll(/['"]([\w.-]+):([\w.-]+):([\w.+-]+)['"]/g)) {
      out.push({ name: `${m[1]}:${m[2]}`, eco: "maven", version: bareVersion(m[3]), manifest: file });
    }
  }

  const pom = read("pom.xml");
  if (pom) {
    for (const m of pom.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
      const block = m[1];
      const group = /<groupId>([^<]+)<\/groupId>/.exec(block)?.[1];
      const artifact = /<artifactId>([^<]+)<\/artifactId>/.exec(block)?.[1];
      const version = /<version>([^<]+)<\/version>/.exec(block)?.[1] ?? "";
      if (group && artifact) {
        out.push({ name: `${group}:${artifact}`, eco: "maven", version: bareVersion(version), manifest: "pom.xml" });
      }
    }
  }

  const cargo = read("Cargo.toml");
  if (cargo) {
    // Only the [dependencies] table; [dev-dependencies] is excluded like npm's.
    const section = /\[dependencies\]([\s\S]*?)(?:\n\[|$)/.exec(cargo)?.[1] ?? "";
    for (const line of section.split("\n")) {
      const short = /^\s*([\w-]+)\s*=\s*"([^"]+)"/.exec(line);
      const table = /^\s*([\w-]+)\s*=\s*\{[^}]*version\s*=\s*"([^"]+)"/.exec(line);
      const hit = short ?? table;
      if (hit) out.push({ name: hit[1], eco: "cargo", version: bareVersion(hit[2]), manifest: "Cargo.toml" });
    }
  }

  return out;
}
