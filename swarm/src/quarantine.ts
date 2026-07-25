// ---------------------------------------------------------------------------
// orchestrator/quarantine.ts — Quarantine Manager
//
// When a task fails (exit 1), it is immediately quarantined for human review.
// No automatic retries. This module manages the quarantine lifecycle:
//   - Write quarantine entries
//   - List all quarantined tasks
//   - Get details of a specific quarantined task
//   - Release a task from quarantine (manual retry)
// ---------------------------------------------------------------------------

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { TaskResult } from './types.js';

/**
 * A quarantine entry representing a failed task shelved for human review.
 */
export interface QuarantineEntry {
  taskId: string;
  result: TaskResult;
  reason: string;
  quarantinedAt: string;
  releasedAt?: string;
}

/**
 * Manages the quarantine zone for failed tasks.
 *
 * Quarantine files are stored as JSON in:
 *   .smith/logs/<taskId>/quarantine.json
 *
 * @example
 * ```typescript
 * const qm = new QuarantineManager('.smith/logs');
 *
 * // Quarantine a failed task
 * await qm.quarantine(result, 'Exit code 1, token limit exceeded');
 *
 * // List all quarantined tasks
 * const entries = await qm.list();
 *
 * // Release for manual retry
 * await qm.release('task-abc123');
 * ```
 */
export class QuarantineManager {
  constructor(private readonly logsDir: string) {}

  /**
   * Quarantine a failed task.
   *
   * Writes a quarantine.json file to .smith/logs/<taskId>/.
   *
   * @param result - The TaskResult from the failed dispatch
   * @param reason - Human-readable reason for quarantine
   * @returns Absolute path to the quarantine file
   */
  async quarantine(result: TaskResult, reason: string): Promise<string> {
    const entry: QuarantineEntry = {
      taskId: result.taskId,
      result,
      reason,
      quarantinedAt: new Date().toISOString(),
    };

    const taskLogDir = join(this.logsDir, result.taskId);
    await mkdir(taskLogDir, { recursive: true });

    const quarantinePath = join(taskLogDir, 'quarantine.json');
    await writeFile(
      quarantinePath,
      JSON.stringify(entry, null, 2),
      'utf-8',
    );

    return quarantinePath;
  }

  /**
   * List all quarantined tasks.
   *
   * Scans the logs directory for subdirectories containing quarantine.json.
   *
   * @returns Array of QuarantineEntry objects
   */
  async list(): Promise<QuarantineEntry[]> {
    const entries: QuarantineEntry[] = [];

    try {
      const taskDirs = await readdir(this.logsDir, { withFileTypes: true });

      for (const dirent of taskDirs) {
        if (!dirent.isDirectory()) continue;

        const quarantinePath = join(
          this.logsDir,
          dirent.name,
          'quarantine.json',
        );

        try {
          const raw = await readFile(quarantinePath, 'utf-8');
          const entry: QuarantineEntry = JSON.parse(raw);
          entries.push(entry);
        } catch {
          // No quarantine file in this dir — skip
        }
      }
    } catch {
      // Logs dir doesn't exist yet — no quarantined tasks
    }

    // Sort by quarantine time, most recent first
    entries.sort((a, b) =>
      new Date(b.quarantinedAt).getTime() -
      new Date(a.quarantinedAt).getTime(),
    );

    return entries;
  }

  /**
   * Get quarantine details for a specific task.
   *
   * @param taskId - The task ID to look up
   * @returns The QuarantineEntry or null if not quarantined
   */
  async get(taskId: string): Promise<QuarantineEntry | null> {
    const quarantinePath = join(this.logsDir, taskId, 'quarantine.json');

    try {
      const raw = await readFile(quarantinePath, 'utf-8');
      return JSON.parse(raw) as QuarantineEntry;
    } catch {
      return null;
    }
  }

  /**
   * Release a task from quarantine.
   *
   * This marks the quarantine entry with a `releasedAt` timestamp
   * but does NOT delete it — the record is preserved for audit.
   *
   * After release, external systems can re-queue the task manifest
   * for another dispatch attempt.
   *
   * @param taskId - The task ID to release
   * @throws Error if the task is not quarantined
   */
  async release(taskId: string): Promise<void> {
    const quarantinePath = join(this.logsDir, taskId, 'quarantine.json');

    let entry: QuarantineEntry;
    try {
      const raw = await readFile(quarantinePath, 'utf-8');
      entry = JSON.parse(raw) as QuarantineEntry;
    } catch {
      throw new Error(
        `Task "${taskId}" is not quarantined or quarantine file not found.`,
      );
    }

    if (entry.releasedAt) {
      throw new Error(
        `Task "${taskId}" was already released at ${entry.releasedAt}.`,
      );
    }

    // Mark as released
    entry.releasedAt = new Date().toISOString();

    await writeFile(
      quarantinePath,
      JSON.stringify(entry, null, 2),
      'utf-8',
    );
  }
}
