// Tiny read-only SQLite reader shared by the drivers whose tools persist
// sessions in a database (opencode, copilot) rather than JSONL files.
//
// Uses the `sqlite3` CLI rather than a native binding on purpose: these reads
// happen a few times a second at most, the binary ships with macOS and every
// Linux we target, and a native module would drag a build toolchain into an
// otherwise pure-TypeScript package. If that trade ever stops paying, swap the
// body of `query()` for node:sqlite — nothing else needs to change.
import { execFile } from 'node:child_process';

/** Run a read-only query, returning rows as objects. Empty on any failure. */
export function query(dbPath: string, sql: string, params: string[] = []): Promise<Array<Record<string, string>>> {
  // Bind parameters positionally through the CLI's own quoting so a session id
  // can never be concatenated into SQL.
  const bound = params.reduce<string>((acc, value) => acc.replace('?', `'${value.replace(/'/g, "''")}'`), sql);
  return new Promise((resolve) => {
    execFile(
      'sqlite3',
      ['-readonly', '-json', dbPath, bound],
      { maxBuffer: 32 * 1024 * 1024 },
      (error, stdout) => {
        if (error || !stdout.trim()) {
          resolve([]);
          return;
        }
        try {
          resolve(JSON.parse(stdout) as Array<Record<string, string>>);
        } catch {
          resolve([]);
        }
      },
    );
  });
}
