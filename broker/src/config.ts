/** Broker configuration from environment (repo-root .env via --env-file). */
export interface BrokerConfig {
  anthropicApiKey: string;
  deepgramApiKey: string;
  elevenlabsApiKey?: string;
  livekit: { url: string; apiKey: string; apiSecret: string };
  swarm: { baseUrl: string; token?: string; repository: string };
  /** Loopback port for the text channel (POST /utterance + WS /events). */
  textPort: number;
  /** Optional: enables the avatar generator. Absent = feature degrades, presets still work. */
  geminiApiKey?: string;
  geminiImageModel: string;
}

export function loadBrokerConfig(env: Record<string, string | undefined> = process.env): BrokerConfig {
  const required = (name: string): string => {
    const v = env[name];
    if (!v) throw new Error(`Missing required env var: ${name}`);
    return v;
  };
  return {
    anthropicApiKey: required('ANTHROPIC_API_KEY'),
    deepgramApiKey: required('DEEPGRAM_API_KEY'),
    elevenlabsApiKey: env.ELEVENLABS_API_KEY || undefined,
    livekit: {
      url: required('LIVEKIT_URL'),
      apiKey: required('LIVEKIT_API_KEY'),
      apiSecret: required('LIVEKIT_API_SECRET'),
    },
    swarm: {
      baseUrl: env.SWARM_URL || 'http://127.0.0.1:7777',
      token: env.SMITH_API_TOKEN || undefined,
      repository: env.SWARM_REPO || '',
    },
    textPort: env.BROKER_TEXT_PORT ? Number(env.BROKER_TEXT_PORT) : 7790,
    geminiApiKey: env.GEMINI_API_KEY || undefined,
    geminiImageModel: env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image',
  };
}
