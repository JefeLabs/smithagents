import mermaid from "mermaid";
import { useEffect, useMemo, useState } from "react";

/**
 * A diagram's section body is stored as a fenced ```mermaid block (so the same
 * text reads cleanly if it ever lands in a prose document too). Mermaid itself
 * wants the bare source, so strip the fence before compiling. A body with no
 * fence (hand-edited source) passes through untouched.
 */
export function stripMermaidFence(code: string): string {
  const trimmed = code.trim();
  if (!trimmed.startsWith("```mermaid")) return trimmed;
  return trimmed
    .replace(/^```mermaid\s*\n?/, "")
    .replace(/\n?```\s*$/, "")
    .trim();
}

// Module-level so every mount gets a DOM-unique render id without Math.random
// (banned in some contexts) — stable-per-mount is all mermaid.render needs.
let initialized = false;
let seq = 0;

/**
 * Compile Mermaid text to an SVG and render it. A parse failure is NOT blank:
 * it falls back to the error message plus the raw source so the author can see
 * and fix what they typed. jsdom can't lay out SVG, so tests mock `mermaid`.
 */
export function MermaidBlock({ code }: { code: string }) {
  const [svg, setSvg] = useState("");
  const [error, setError] = useState<string | null>(null);
  const id = useMemo(() => {
    const next = `mmd-${seq}`;
    seq += 1;
    return next;
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!initialized) {
      // securityLevel:"strict" makes mermaid run its bundled DOMPurify over the
      // SVG it returns, so the markup we inject below is already sanitized. Pin
      // it rather than trust the (currently strict) default across major bumps.
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });
      initialized = true;
    }
    mermaid
      .render(id, stripMermaidFence(code))
      .then(({ svg: out }) => {
        if (cancelled) return;
        setSvg(out);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setSvg("");
      });
    return () => {
      cancelled = true;
    };
  }, [code, id]);

  if (error) {
    return (
      <pre role="alert" className="mermaid-block__error">
        {error}
        {"\n\n"}
        {code}
      </pre>
    );
  }
  // biome-ignore lint/security/noDangerouslySetInnerHtml: mermaid.render returns SVG markup we generated; there is no other way to mount it.
  return <div className="mermaid-block" dangerouslySetInnerHTML={{ __html: svg }} />;
}
