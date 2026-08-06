/**
 * AvatarGenerator — one Gemini image call that gives a teammate a face.
 *
 * The house style lives here, not in the UI: every portrait — preset art
 * authored at build time and custom art generated in the wizard — goes
 * through this prompt, so the whole cast reads as one set. Output is
 * normalized to a 512×512 PNG so the swarm's 2 MB avatarData cap and the
 * roster's 40px rendering never meet a surprise.
 */
import sharp from 'sharp';

export interface AvatarRequest {
  name?: string;
  gender?: string;
  role?: string;
  backstory?: string;
  stereotype?: string;
}

/** Minimal shape of the @google/genai client this needs — keeps testing trivial. */
export interface ImagesClient {
  models: {
    generateContent(params: { model: string; contents: string; config?: Record<string, unknown> }): Promise<{
      candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { data?: string; mimeType?: string } }> } }>;
    }>;
  };
}

const HOUSE_STYLE =
  'Flat vector bust portrait of a software professional, bold geometric shapes, limited warm palette, ' +
  'solid single-color background, centered, square crop, no text, no logos, no watermark.';

export function buildAvatarPrompt(req: AvatarRequest): string {
  const subject = req.gender === 'male' ? 'A man' : req.gender === 'female' ? 'A woman' : 'A person';
  const clauses = [
    HOUSE_STYLE,
    `${subject}${req.name ? ` called ${req.name}` : ''}${req.role ? `, a ${req.role}` : ''}.`,
  ];
  if (req.backstory) clauses.push(`Character notes: ${req.backstory.slice(0, 400)}`);
  return clauses.join(' ');
}

export class AvatarGenerator {
  constructor(
    private readonly client: ImagesClient,
    private readonly model: string,
  ) {}

  /** Base64 of a 512×512 PNG. Throws with a message the wizard can show verbatim. */
  async generate(req: AvatarRequest): Promise<string> {
    const res = await this.client.models.generateContent({
      model: this.model,
      contents: buildAvatarPrompt(req),
      config: { responseModalities: ['IMAGE'] },
    });
    const data = res.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData?.data;
    if (!data) throw new Error('Gemini returned no image — try again');
    const png = await sharp(Buffer.from(data, 'base64')).resize(512, 512, { fit: 'cover' }).png().toBuffer();
    return png.toString('base64');
  }
}
