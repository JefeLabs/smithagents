/**
 * PersonaGenerator — one model call that fills the whole creation wizard.
 *
 * The user picks a stereotype and a job role (or nothing at all) and gets a
 * complete teammate back: name, role, backstory, speaking style, reactions
 * across the agreement spectrum, and answers to every first-meeting question.
 * Structured outputs guarantee the shape, so the wizard can populate its
 * fields without parsing prose — and every field stays editable afterwards.
 */
export interface GenerateRequest {
  stereotypeLabel?: string;
  stereotypeStyle?: string;
  jobRoleLabel?: string;
  jobRoleDirectives?: string;
  gender?: string;
  /** Free-text steer: "grumpy veteran", "fresh out of school, eager". */
  hint?: string;
  /**
   * How this teammate should sound, from the chosen primary language
   * (personas.LANGUAGES[].speech). Absent = the crew's Dominican default.
   */
  speech?: string;
  /** Crew identity so a generated teammate fits the existing cast. */
  crewContext?: string;
  reactionLevels: string[];
  quickQuestions: Array<{ id: string; question: string }>;
  /** Names already taken — the generator must not collide with them. */
  existingNames?: string[];
}

export interface PersonaDraft {
  name: string;
  role: string;
  backstory: string;
  style: string;
  directives: string;
  reactions: Array<{ level: string; line: string }>;
  quickAnswers: Array<{ id: string; answer: string }>;
}

/** Minimal shape of the Anthropic client this needs — keeps testing trivial. */
export interface MessagesClient {
  messages: {
    create(params: Record<string, unknown>): Promise<{ content: Array<{ type: string; text?: string }> }>;
  };
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'role', 'backstory', 'style', 'directives', 'reactions', 'quickAnswers'],
  properties: {
    name: { type: 'string', description: 'First name only. Fits the crew; never one already taken.' },
    role: { type: 'string', description: 'Short title, e.g. "Security Engineer" or "The Skeptic of QA".' },
    backstory: { type: 'string', description: '2-3 sentences of history that explain how they work.' },
    style: { type: 'string', description: 'How they speak in meetings: tone, rhythm, verbal habits.' },
    directives: { type: 'string', description: 'What they own and how they approach it — the work prompt.' },
    reactions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['level', 'line'],
        properties: {
          level: { type: 'string' },
          line: { type: 'string', description: 'One spoken sentence, in character, under 90 characters.' },
        },
      },
    },
    quickAnswers: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'answer'],
        properties: {
          id: { type: 'string' },
          answer: { type: 'string', description: 'One or two spoken sentences, in character.' },
        },
      },
    },
  },
} as const;

export class PersonaGenerator {
  constructor(
    private readonly client: MessagesClient,
    private readonly model = 'claude-opus-5',
  ) {}

  async generate(req: GenerateRequest): Promise<PersonaDraft> {
    const brief = [
      req.stereotypeLabel ? `Archetype: ${req.stereotypeLabel} — ${req.stereotypeStyle ?? ''}` : 'Archetype: your choice.',
      req.jobRoleLabel ? `Job: ${req.jobRoleLabel} — ${req.jobRoleDirectives ?? ''}` : 'Job: your choice.',
      req.gender && req.gender !== 'neutral' ? `Gender: ${req.gender}.` : '',
      req.hint ? `The human asks for: ${req.hint}` : '',
      req.crewContext ? `Existing crew: ${req.crewContext}` : '',
      req.existingNames?.length ? `Names already taken (do NOT reuse): ${req.existingNames.join(', ')}.` : '',
      '',
      `Write one reaction line for EACH of these levels, in this exact id set: ${req.reactionLevels.join(', ')}.`,
      'Answer EACH of these questions in character, keyed by id:',
      ...req.quickQuestions.map((q) => `  ${q.id}: ${q.question}`),
    ]
      .filter(Boolean)
      .join('\n');

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 4096,
      system:
        'You invent a member of a tight AI engineering crew. ' +
        `They speak ${req.speech ?? 'English with natural Dominican Spanish sprinkled in ("dale", "tranquilo", "mi gente")'}, ` +
        'and every line you write is SPOKEN ALOUD in a live meeting: short, human, never bulleted, never corporate. ' +
        'Give them a specific personality with edges — likes, irritations, a way of disagreeing that is theirs alone. ' +
        'Vary rhythm between agents; avoid stock phrasing.',
      messages: [{ role: 'user', content: brief }],
      output_config: { format: { type: 'json_schema', schema: SCHEMA } },
    });

    const text = response.content.find((b) => b.type === 'text')?.text ?? '';
    let draft: PersonaDraft;
    try {
      draft = JSON.parse(text) as PersonaDraft;
    } catch (err) {
      throw new Error(`persona generation returned unparseable output: ${String(err)}`);
    }
    // Keep only the ids the wizard asked for — a hallucinated key would land
    // in the persona file and never be shown or spoken.
    const levels = new Set(req.reactionLevels);
    const questionIds = new Set(req.quickQuestions.map((q) => q.id));
    draft.reactions = (draft.reactions ?? []).filter((r) => levels.has(r.level));
    draft.quickAnswers = (draft.quickAnswers ?? []).filter((a) => questionIds.has(a.id));
    return draft;
  }
}
