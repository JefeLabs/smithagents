import { Markdown } from "@heroui-pro/react/markdown";

/**
 * Temporary. Proves `@heroui-pro/react/markdown` and its optional peers
 * (streamdown, react-markdown, marked, remark-gfm) resolve before Transcript
 * depends on them. Deleted in Task 4, exactly as Phase 0's HeroCanary was.
 */
export function MarkdownCanary({ source }: { source: string }) {
  return <Markdown>{source}</Markdown>;
}
