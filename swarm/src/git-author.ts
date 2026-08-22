// Who a commit into the org config repo is BY (spec 2026-08-22 §1.4).
//
// There is no author in filenames or frontmatter: git is the authorship
// record, and a document can change hands. That only works if every commit
// names the person or agent who acted — the tool itself is the committer.
import type { User } from "./users.js";
import { slugForDir } from "./workspaces.js";

export interface GitAuthor {
  name: string;
  email: string;
}

/** The tool's own identity — the COMMITTER on every org-repo commit, and the author when nobody in particular acted (boot-time healing). */
export const SMITH_IDENTITY: GitAuthor = { name: "smithagents", email: "smithagents@localhost" };

/**
 * The acting user as a git author. A user without an email gets a
 * deterministic address under `users.smithagents`, so `git blame` still
 * names a person rather than the tool.
 */
export function userAuthor(user: User | null): GitAuthor {
  if (!user) return SMITH_IDENTITY;
  const name = user.name.trim() || user.id;
  const email = user.email?.trim() || `${slugForDir(name) || user.id}@users.smithagents`;
  return { name, email };
}
