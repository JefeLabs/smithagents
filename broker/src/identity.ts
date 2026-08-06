/**
 * BrokerIdentity — the broker's own data-driven persona (the "host", shipped
 * default Anderson). Deliberately NOT an agent: no engine (the broker brain
 * is the engine), no channels (the host exists wherever the broker fronts),
 * never present in the swarm registry or the delegable roster.
 *
 * Zero imports: the file reader is injected so tests never touch disk.
 */

export interface IdentityPromptInfo {
  name: string;
  role: string;
  style: string;
}

export interface BrokerIdentity {
  id: string;
  name: string;
  role: string;
  persona: { style: string };
  backstory?: string;
  gender?: string;
  language?: string;
  avatarRing: string;
  voice: { voiceId?: string; speech?: { voiceName?: string; lang?: string; pitch?: number; rate?: number } };
  quickAnswers?: Record<string, string>;
}

export const DEFAULT_IDENTITY: BrokerIdentity = {
  id: 'anderson',
  name: 'Anderson',
  role: 'Chief of Staff',
  persona: {
    style:
      "Calm, dry, unhurried — the one who never needs to raise his voice. Short, exact sentences with a host's warmth underneath. Spanish only for courtesy — 'bienvenido', 'con calma'. Introduces, summarizes, routes, and steps back; never competes with the crew for the floor.",
  },
  backstory:
    'Ran the front desk of a Santo Domingo hotel lobby that never slept, then fifteen years as chief of staff to people with too many meetings. Knows every name, every room, and exactly who to call.',
  gender: 'male',
  language: 'en-do',
  avatarRing: '#8a93a6',
  voice: {},
  quickAnswers: {
    name: 'Anderson. The crew works; I keep the room.',
    role: "Chief of staff. I know who is free, who is deep in something, and who you need — ask me and I'll route you.",
    availability: "Always here. I don't take tasks, so I'm never busy.",
  },
};

/** Load the identity file, merging over DEFAULT_IDENTITY; any failure returns the default. */
export function loadIdentity(read: () => string): BrokerIdentity {
  try {
    const raw = JSON.parse(read()) as Record<string, unknown>;
    if (typeof raw !== 'object' || raw === null) return DEFAULT_IDENTITY;
    if ('name' in raw && typeof raw.name !== 'string') return DEFAULT_IDENTITY;
    const persona = raw.persona as { style?: unknown } | undefined;
    return {
      id: typeof raw.id === 'string' ? raw.id : DEFAULT_IDENTITY.id,
      name: typeof raw.name === 'string' ? raw.name : DEFAULT_IDENTITY.name,
      role: typeof raw.role === 'string' ? raw.role : DEFAULT_IDENTITY.role,
      persona: { style: typeof persona?.style === 'string' ? persona.style : DEFAULT_IDENTITY.persona.style },
      backstory: typeof raw.backstory === 'string' ? raw.backstory : DEFAULT_IDENTITY.backstory,
      gender: typeof raw.gender === 'string' ? raw.gender : DEFAULT_IDENTITY.gender,
      language: typeof raw.language === 'string' ? raw.language : DEFAULT_IDENTITY.language,
      avatarRing: typeof raw.avatarRing === 'string' ? raw.avatarRing : DEFAULT_IDENTITY.avatarRing,
      voice: (raw.voice as BrokerIdentity['voice']) ?? DEFAULT_IDENTITY.voice,
      quickAnswers: (raw.quickAnswers as Record<string, string>) ?? DEFAULT_IDENTITY.quickAnswers,
    };
  } catch {
    return DEFAULT_IDENTITY;
  }
}

/** The three fields the brain prompt interpolates. */
export function promptInfo(i: BrokerIdentity): IdentityPromptInfo {
  return { name: i.name, role: i.role, style: i.persona.style };
}
