/**
 * Discovery is a real research dispatch to a CLI agent, which has web access
 * the brain does not (spec §3).
 *
 * The agent WRITES a bundle file rather than printing it: getOutput() returns
 * raw terminal scrollback — ANSI codes, wrapping, the agent's own commentary —
 * and parsing a bundle out of that works while you watch and fails on a long
 * day.
 */
import type { Topic } from './topics.ts';

export function discoveryBrief(topic: Topic, bundlePath: string): string {
  return [
    `Find the places "${topic.name}" publishes. Look for up to four kinds of source:`,
    '',
    '  site    — the official blog or news page, and its RSS/Atom feed URL',
    '  github  — the main repository, if it has one',
    '  youtube — the official channel, if it has one',
    '  x       — the official X account, if it has one',
    '',
    `Write your findings as JSON to ${bundlePath} — do not print them to the terminal.`,
    '',
    'Shape:',
    '{ "candidates": [',
    '    { "kind": "site", "url": "…", "label": "…", "evidence": "…", "lastActivity": "2026-08-09" }',
    '] }',
    '',
    'For each: `url` is the FEED url for a site (look for <link rel="alternate">), the repo',
    'url for github, the channel url for youtube, the profile url for x. `evidence` is one',
    'short line on why you believe it is official. `lastActivity` is the date of the newest',
    'item you saw there.',
    '',
    'Omit any kind you cannot find or cannot verify as official — a missing source is much',
    'better than a wrong one. Write the file even if you find only one.',
  ].join('\n');
}

export async function startDiscovery(
  deps: {
    dispatch(task: string): Promise<{ taskId: string } | { error: string }>;
    bundlePath(topicId: string): string;
  },
  topic: Topic,
): Promise<{ topic: Topic; taskId?: string }> {
  const result = await deps.dispatch(discoveryBrief(topic, deps.bundlePath(topic.id)));
  if ('error' in result) {
    // Stays discovering: the timer retries. Every non-active status says why.
    return { topic: { ...topic, status: 'discovering', note: result.error } };
  }
  return { topic: { ...topic, status: 'discovering', note: undefined }, taskId: result.taskId };
}
