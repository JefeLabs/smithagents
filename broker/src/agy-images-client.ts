// Subscription-path avatar engine: drives headless `agy --sandbox -p` (Antigravity's
// native Nano Banana) and adapts its file output to the ImagesClient shape
// AvatarGenerator already consumes. Empirics behind the wrapper (spec
// §Avatar generation): ~60–90s per image, imperfect path discipline, and
// JPEG output mislabeled .png — so the run is contained in a fresh temp
// dir, whatever image lands there is collected regardless of name, and
// sharp downstream normalizes size/format. --sandbox is the isolation
// boundary; --dangerously-skip-permissions only auto-approves inside it,
// protecting against hostile prompts that embed owner-typed wizard fields.
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImagesClient } from "./avatar-generator.ts";

export type AgyRunner = (
  argv: string[],
  cwd: string,
  timeoutMs: number,
) => Promise<{ code: number | null; stdout: string; stderr: string }>;

const defaultRunner: AgyRunner = (argv, cwd, timeoutMs) =>
  new Promise((done) => {
    execFile(argv[0], argv.slice(1), { cwd, timeout: timeoutMs }, (err, stdout, stderr) => {
      const code = err
        ? typeof (err as { code?: unknown }).code === "number"
          ? (err as { code: number }).code
          : null // killed by timeout/signal
        : 0;
      done({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });

const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;
const TIMEOUT_MS = 180_000; // spec: 3 minutes

export class AgyImagesClient implements ImagesClient {
  constructor(
    private readonly binary = "agy",
    private readonly run: AgyRunner = defaultRunner,
  ) {}

  readonly models = {
    generateContent: async ({ contents }: { model: string; contents: string; config?: Record<string, unknown> }) => {
      const dir = await mkdtemp(join(tmpdir(), "smith-avatar-"));
      try {
        const prompt =
          `${contents} Generate exactly one image and save it into the current working directory (${dir}). ` +
          "Write no other files anywhere else.";
        const res = await this.run(
          [this.binary, "--sandbox", "-p", prompt, "--dangerously-skip-permissions", "--add-dir", dir],
          dir,
          TIMEOUT_MS,
        );
        const images = (await readdir(dir)).filter((f) => IMAGE_EXT.test(f));
        if (res.code !== 0 || images.length === 0) {
          throw new Error(
            `agy produced no image${res.code !== 0 ? ` (exit ${res.code})` : ""} — try again, or add a Google key in Settings → API Keys`,
          );
        }
        const data = (await readFile(join(dir, images[0]))).toString("base64");
        // mimeType is advisory — AvatarGenerator pipes bytes through sharp,
        // which sniffs the real format (the JPEG-named-.png case).
        return { candidates: [{ content: { parts: [{ inlineData: { data, mimeType: "image/png" } }] } }] };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}
