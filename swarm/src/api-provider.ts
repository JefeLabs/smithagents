// The provider seam for api-kind agents (api-runtime spec 2026-08-13): one
// tiny interface a turn runs through, one real implementation (Anthropic
// Messages API), one mock for tests. The key is read from the encrypted
// registry AT CALL TIME — rotation needs no restart — and every failure is
// typed and names its fix; a swallowed provider error would read as a
// silent agent.
import { getCredential } from "./api-keys.js";

export interface ApiTurnRequest {
  model: string;
  system: string;
  messages: Array<{ role: "user" | "assistant"; text: string }>;
}

export interface ApiProvider {
  complete(req: ApiTurnRequest): Promise<string>;
}

export type ApiErrorKind = "auth" | "billing" | "provider" | "network";

export class ApiProviderError extends Error {
  readonly kind: ApiErrorKind;
  constructor(kind: ApiErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

export class AnthropicProvider implements ApiProvider {
  constructor(private readonly keyPath: string) {}

  async complete(req: ApiTurnRequest): Promise<string> {
    const cred = await getCredential(this.keyPath, "anthropic");
    if ("error" in cred) {
      throw new ApiProviderError("auth", `${cred.error} — verify the key in Settings → API Keys`);
    }
    let res: Response;
    try {
      res = await fetch(ANTHROPIC_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": cred.key,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: req.model,
          max_tokens: 1024,
          system: req.system,
          messages: req.messages.map((m) => ({ role: m.role, content: m.text })),
        }),
      });
    } catch (err) {
      throw new ApiProviderError("network", `Could not reach Anthropic: ${String((err as Error).message)}`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      if (res.status === 401 || res.status === 403) {
        throw new ApiProviderError("auth", "Anthropic rejected the API key — verify it in Settings → API Keys");
      }
      if (res.status === 429 || /credit|billing/i.test(body)) {
        throw new ApiProviderError(
          "billing",
          "Anthropic refused the turn over credits or rate limits — top up the account, then retry",
        );
      }
      throw new ApiProviderError("provider", `Anthropic error ${res.status}: ${body.slice(0, 200)}`);
    }
    const parsed = (await res.json().catch(() => null)) as { content?: Array<{ type: string; text?: string }> } | null;
    const text = parsed?.content
      ?.filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("");
    if (!text) throw new ApiProviderError("provider", "Anthropic returned no text content");
    return text;
  }
}

/** Test seam: scripted replies, records everything it was asked. */
export class MockProvider implements ApiProvider {
  readonly calls: ApiTurnRequest[] = [];
  private replies: Array<string | ApiProviderError>;
  constructor(replies: Array<string | ApiProviderError> = []) {
    this.replies = replies;
  }
  complete(req: ApiTurnRequest): Promise<string> {
    this.calls.push(req);
    const next = this.replies.shift() ?? `reply ${this.calls.length}`;
    if (next instanceof ApiProviderError) return Promise.reject(next);
    return Promise.resolve(next);
  }
}
