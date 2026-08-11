/** Broker configuration from environment (repo-root .env via --env-file). */
export interface BrokerConfig {
  anthropicApiKey: string;
  livekit: { url: string; apiKey: string; apiSecret: string };
  swarm: { baseUrl: string; token?: string; repository: string };
  /** Loopback port for the text channel (POST /utterance + WS /events). */
  textPort: number;
  /** Bind address for the text channel. Non-loopback requires auth. */
  host: string;
  /** Inbound identity config (passkey humans + bridge bearer). */
  auth: {
    /** true = every route/WS gated; false = open loopback dev mode. */
    required: boolean;
    /** Passkey rpID (the tenant domain) — fixed for life. */
    rpId: string;
    /** WebAuthn expected origin (the SPA's origin). */
    webOrigin: string;
    /** Static bearer for smith-broker-send/check. */
    bridgeToken?: string;
    /** Where users/sessions persist. */
    file: string;
  };
  /** Optional: enables the avatar generator. Absent = feature degrades, presets still work. */
  geminiApiKey?: string;
  geminiImageModel: string;
}

export function loadBrokerConfig(env: Record<string, string | undefined> = process.env): BrokerConfig {
  const requiredVar = (name: string): string => {
    const v = env[name];
    if (!v) throw new Error(`Missing required env var: ${name}`);
    return v;
  };
  const host = env.BROKER_HOST || '127.0.0.1';
  const required = env.SMITH_BROKER_AUTH === 'required';
  // The bind address stops being the security boundary the moment it leaves
  // loopback — refuse to trade it for nothing (mirrors swarm's refusal).
  if (!['127.0.0.1', '::1', 'localhost'].includes(host) && !required) {
    throw new Error(
      `Refusing BROKER_HOST=${host} without SMITH_BROKER_AUTH=required. ` +
      'Set SMITH_BROKER_AUTH=required (and SMITH_BROKER_TOKEN for bridges) to bind beyond loopback.',
    );
  }
  return {
    anthropicApiKey: requiredVar('ANTHROPIC_API_KEY'),
    livekit: {
      url: requiredVar('LIVEKIT_URL'),
      apiKey: requiredVar('LIVEKIT_API_KEY'),
      apiSecret: requiredVar('LIVEKIT_API_SECRET'),
    },
    swarm: {
      baseUrl: env.SWARM_URL || 'http://127.0.0.1:7777',
      token: env.SMITH_API_TOKEN || undefined,
      repository: env.SWARM_REPO || '',
    },
    textPort: env.BROKER_TEXT_PORT ? Number(env.BROKER_TEXT_PORT) : 7790,
    host,
    auth: {
      required,
      rpId: env.SMITH_BROKER_RPID || 'localhost',
      webOrigin: env.SMITH_BROKER_WEB_ORIGIN || 'http://localhost:1420',
      bridgeToken: env.SMITH_BROKER_TOKEN || undefined,
      file: env.SMITH_BROKER_AUTH_FILE || '.smith/auth.json',
    },
    geminiApiKey: env.GEMINI_API_KEY || undefined,
    geminiImageModel: env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image',
  };
}
