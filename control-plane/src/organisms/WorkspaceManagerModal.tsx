import { Button } from "@heroui/react";
import { Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useFieldArray, useForm } from "react-hook-form";
import type { ConnectorInstanceRecord, GroupT, WorkspaceRecord } from "../api/types";
import { anchorToWeekday, WEEKDAYS, weekdayToAnchor } from "../lib/dateRange";
import { ConfirmSheet } from "../molecules/ConfirmSheet";
import { FormCheckbox, FormColorSwatch, FormSelect, FormTextField, ModalShell } from "../molecules/form";
import { useUiStore } from "../stores/uiStore";
import { GroupsSection } from "./GroupsSection";

interface WorkspaceManagerModalProps {
  open: boolean;
  onClose: () => void;
  list: () => Promise<WorkspaceRecord[]>;
  save: (ws: WorkspaceRecord, isNew: boolean) => Promise<{ error?: string }>;
  remove: (name: string) => Promise<{ outcome?: string; error?: string }>;
  verifyAtlassian: (name: string) => Promise<{ ok?: boolean; detail?: string; error?: string }>;
  verifyRepoGithub: (name: string, repoName: string) => Promise<{ ok?: boolean; detail?: string; error?: string }>;
  // Optional so HomePage.tsx (wired up in a later task) isn't forced to pass it before
  // it has a real implementation to hand over — defaults to an empty roster below.
  listMyConnectors?: () => Promise<ConnectorInstanceRecord[]>;
  /** Workspace groups (spec 2026-08-11-workspace-groups §5) — the section renders only when all three are provided. */
  groups?: GroupT[];
  saveGroup?: (
    body: { name: string; description?: string; color?: string; workspaces: string[]; groups: string[] },
    isNew: boolean,
  ) => Promise<{ error?: string }>;
  deleteGroup?: (name: string) => Promise<{ error?: string }>;
}

/**
 * The editable draft. Most fields are plain strings so RHF owns them directly; the
 * record's optional blocks (`atlassian`, a repo's `github`) are rebuilt in `toRecord`
 * at submit, which is where the "half-filled block is not a block" rule already lived.
 *
 * The two Atlassian key lists stay ARRAYS even though the UI exposes a single input
 * each. The input is bound to index 0; entries 1..N are carried through untouched. The
 * schema and the on-disk `.smith/workspaces/*.json` both permit multiple keys, and
 * `PUT /workspaces/:name` replaces the whole `atlassian` block
 * (`swarm/src/server.ts:1477`), so flattening to `[0]` here would silently and
 * permanently drop the tail of a hand-written or externally-produced record on the
 * first unrelated save in this modal.
 */
interface WorkspaceFormValues {
  name: string;
  description: string;
  /** Raw textarea text — kept separate from the record's `links` so a trailing blank line
      while typing isn't immediately collapsed away (same pattern as NewWorkspaceModal). */
  linksText: string;
  /** "" means no colour picked. */
  color: string;
  /** The Sprint Filter toggle (date-range spec 2026-08-12) — ON requires a start day and a length. */
  sprintEnabled: boolean;
  sprintWeekday: string; // "" | "1".."7" (ISO Mon..Sun)
  sprintLength: string;
  default: boolean;
  atlassian: {
    siteUrl: string;
    connectorId: string;
    /** Index 0 is the edited one; the rest ride along. */
    jiraProjectKeys: string[];
    confluenceSpaceKeys: string[];
  };
  repos: Array<{
    name: string;
    path: string;
    branch: string;
    owner: string;
    repo: string;
    connectorId: string;
    initGit?: boolean;
  }>;
}

const emptyRepo = () => ({ name: "", path: "", branch: "main", owner: "", repo: "", connectorId: "" });

const noAtlassian = () => ({ siteUrl: "", connectorId: "", jiraProjectKeys: [], confluenceSpaceKeys: [] });

/** Drops blanks (including a cleared index 0) and collapses an empty list to undefined, as the record expects. */
const keyList = (keys: string[]): string[] | undefined => {
  const kept = keys.filter((k) => k.trim());
  return kept.length > 0 ? kept : undefined;
};

/** Non-blank after trimming — the two fields per repo, plus the name, that gate saving. */
const filled = (v: string) => v.trim().length > 0;

/** The "new workspace" starting point — first-ever workspace defaults itself in, mirroring swarm's own rule. */
function blankForm(noWorkspacesYet: boolean): WorkspaceFormValues {
  return {
    name: "",
    description: "",
    linksText: "",
    color: "",
    sprintEnabled: false,
    sprintWeekday: "",
    sprintLength: "",
    default: noWorkspacesYet,
    atlassian: noAtlassian(),
    repos: [emptyRepo()],
  };
}

/** A stored record, flattened into the editable draft above. */
function toForm(ws: WorkspaceRecord): WorkspaceFormValues {
  return {
    name: ws.name,
    description: ws.description ?? "",
    linksText: (ws.links ?? []).join("\n"),
    color: ws.color ?? "",
    sprintEnabled: Boolean(ws.sprint),
    sprintWeekday: ws.sprint ? String(anchorToWeekday(ws.sprint.anchor)) : "",
    sprintLength: ws.sprint ? String(ws.sprint.lengthDays) : "",
    default: ws.default,
    atlassian: {
      siteUrl: ws.atlassian?.siteUrl ?? "",
      connectorId: ws.atlassian?.connectorId ?? "",
      // Whole arrays, not just [0] — see WorkspaceFormValues.
      jiraProjectKeys: [...(ws.atlassian?.jiraProjectKeys ?? [])],
      confluenceSpaceKeys: [...(ws.atlassian?.confluenceSpaceKeys ?? [])],
    },
    repos: ws.repos.map((r) => ({
      name: r.name,
      path: r.path,
      branch: r.branch,
      owner: r.github?.owner ?? "",
      repo: r.github?.repo ?? "",
      connectorId: r.github?.connectorId ?? "",
      ...(r.initGit ? { initGit: true } : {}),
    })),
  };
}

/**
 * The draft, back into a record to save. A half-filled atlassian/github block
 * (project key typed before site URL, or one of owner/repo left blank) must never
 * be submitted as if it were configured — that normalization happens here rather
 * than in each onChange, so typing in any order never appears to drop a field.
 *
 * NOTE: this is a closed allowlist, unlike the `{...form}` spread it replaced. A field
 * added to `WorkspaceRecord` later will be silently dropped from every save made here
 * until it is listed below. `archived` is the only currently-unrepresented field, and
 * omitting it is safe: `PUT /workspaces/:name` falls back to `existing.archived`
 * (`swarm/src/server.ts:1476`), and this modal only ever lists un-archived workspaces.
 */
function toRecord(v: WorkspaceFormValues): WorkspaceRecord {
  return {
    name: v.name,
    description: v.description,
    default: v.default,
    // PUT reads an absent colour as "keep the existing one", so unpicking
    // has to travel as an empty string to actually clear it. Both routes
    // collapse "" to undefined before saving; the convention is untouched.
    color: v.color,
    links: v.linksText
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean),
    // Toggle OFF (or half-filled, which submit refuses before reaching here)
    // saves as absent — the same block rule as atlassian/github below.
    sprint: ((): WorkspaceRecord["sprint"] => {
      if (!v.sprintEnabled) return undefined;
      const weekday = Number.parseInt(v.sprintWeekday, 10);
      const lengthDays = Number.parseInt(v.sprintLength, 10);
      return Number.isInteger(weekday) && Number.isInteger(lengthDays) && lengthDays > 0
        ? { anchor: weekdayToAnchor(weekday), lengthDays }
        : undefined;
    })(),
    atlassian: v.atlassian.siteUrl.trim()
      ? {
          siteUrl: v.atlassian.siteUrl,
          connectorId: v.atlassian.connectorId || undefined,
          jiraProjectKeys: keyList(v.atlassian.jiraProjectKeys),
          confluenceSpaceKeys: keyList(v.atlassian.confluenceSpaceKeys),
        }
      : undefined,
    repos: v.repos.map((r) => ({
      name: r.name,
      path: r.path,
      branch: r.branch,
      github:
        r.owner.trim() && r.repo.trim()
          ? { owner: r.owner, repo: r.repo, connectorId: r.connectorId || undefined }
          : undefined,
      ...(r.initGit ? { initGit: true } : {}),
    })),
  };
}

/**
 * NOT part of the model above — a render-layer patch applied only at `reset()` call
 * sites, never inside `toForm`/`blankForm` themselves.
 *
 * The two Atlassian key inputs are bound to a fixed `.0` path on an array that can be
 * shorter than 1 (no keys stored, or a fresh workspace). The old plain `<input
 * {...register(...)}>` left an out-of-range index alone until the user typed into it.
 * `FormTextField` is a *controlled* field (`useController`), and mounting one against
 * an index that doesn't exist yet materializes `undefined` there — silently growing
 * `[]` to `[undefined]`. `keyList` (unmodified, and rightly so: it already treats a
 * blank string exactly like an absent entry) then does `undefined.trim()` and throws.
 * Padding a length-0 array to `[""]` before it reaches `useForm` heads that off — same
 * `keyList` result either way — without touching `toForm`/`blankForm`/`keyList` themselves.
 */
function padKeys(v: WorkspaceFormValues): WorkspaceFormValues {
  return {
    ...v,
    atlassian: {
      ...v.atlassian,
      jiraProjectKeys: v.atlassian.jiraProjectKeys.length > 0 ? v.atlassian.jiraProjectKeys : [""],
      confluenceSpaceKeys: v.atlassian.confluenceSpaceKeys.length > 0 ? v.atlassian.confluenceSpaceKeys : [""],
    },
  };
}

/**
 * Create, edit and remove workspaces. Left column lists active workspaces
 * (archived ones are hidden here, not deletable — they're history); the
 * right column is the form, reused for both create and edit.
 */
export function WorkspaceManagerModal({
  open,
  onClose,
  list,
  save,
  remove,
  verifyAtlassian,
  verifyRepoGithub,
  listMyConnectors = async () => [],
  groups,
  saveGroup,
  deleteGroup,
}: WorkspaceManagerModalProps) {
  const [workspaces, setWorkspaces] = useState<WorkspaceRecord[]>([]);
  // One field per selector (house rule): the "New group…" landing intent.
  const groupFormIntent = useUiStore((s) => s.groupFormIntent);
  const clearGroupFormIntent = useUiStore((s) => s.clearGroupFormIntent);
  const [connectors, setConnectors] = useState<ConnectorInstanceRecord[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** Workspace name being edited; null means the form is building a new one. */
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<{ name: string; busy?: boolean; error?: string } | null>(null);
  const [testResult, setTestResult] = useState<{ target: string; ok: boolean; detail: string } | null>(null);
  const [testing, setTesting] = useState<string | null>(null);

  // mode: "onChange" because the save button gates on isValid — this is the
  // `canSave` rule (name, plus every repo's name and path) expressed as rules.
  const {
    control,
    handleSubmit,
    reset,
    watch,
    formState: { isValid, isSubmitting },
  } = useForm<WorkspaceFormValues>({ mode: "onChange", defaultValues: blankForm(true) });
  const { fields, append, remove: removeRepoAt } = useFieldArray({ control, name: "repos" });

  const active = workspaces.filter((w) => !w.archived);
  const atlassianConnectors = connectors.filter((c) => c.vendorId === "atlassian");
  const githubConnectors = connectors.filter((c) => c.vendorId === "github");

  // Owner/repo decide whether a repo row offers its Test button; siteUrl does the same
  // for the Atlassian block. `name` is read back after a save to re-select the record.
  const repoValues = watch("repos");
  const atlassianSiteUrl = watch("atlassian.siteUrl");

  const refresh = async (): Promise<WorkspaceRecord[]> => {
    setLoadError(null);
    const records = await list().catch((err: unknown): WorkspaceRecord[] => {
      setLoadError(`Could not load workspaces — ${String(err)}`);
      return [];
    });
    setWorkspaces(records);
    return records;
  };

  // Reset to a blank "new workspace" form every time the modal opens. Also
  // drops any leftover remove-confirmation from the last time this modal was
  // open — otherwise a stale `removing` could resurface a confirmation for a
  // workspace the user never asked to remove this time around. HomePage keeps
  // this modal mounted and toggles `open`, so useForm's per-mount defaults run
  // only once; the reset here is what actually clears a reopen.
  // Deliberately keyed on `open` only — `list` is a stable-enough prop
  // function and refetching on every parent render would be pointless.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    if (!open) return;
    setRemoving(null);
    void refresh().then((records) => {
      setSelected(null);
      reset(padKeys(blankForm(records.filter((w) => !w.archived).length === 0)));
      setError(null);
    });
  }, [open]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: see the existing open-effect above this one for the same reasoning
  useEffect(() => {
    if (!open) return;
    void listMyConnectors().then(setConnectors);
  }, [open]);

  // Escape cancels an open remove-confirmation first; only closes the whole
  // manager once no sheet is in the way, so a stray Escape can't blow past a
  // pending confirmation and dismiss more than the user intended.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (removing) setRemoving(null);
      else onClose();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [open, onClose, removing]);

  if (!open) return null;

  const startNew = () => {
    setSelected(null);
    reset(padKeys(blankForm(active.length === 0)));
    setError(null);
    setTestResult(null);
  };

  const selectWorkspace = (ws: WorkspaceRecord) => {
    setSelected(ws.name);
    reset(padKeys(toForm(ws)));
    setError(null);
    setTestResult(null);
  };

  const testAtlassian = async () => {
    if (!selected) return;
    setTesting("atlassian");
    const r = await verifyAtlassian(selected);
    setTesting(null);
    setTestResult({ target: "atlassian", ok: Boolean(r.ok), detail: r.detail ?? r.error ?? "unknown" });
  };

  const testRepoGithub = async (repoName: string) => {
    if (!selected) return;
    setTesting(repoName);
    const r = await verifyRepoGithub(selected, repoName);
    setTesting(null);
    setTestResult({ target: repoName, ok: Boolean(r.ok), detail: r.detail ?? r.error ?? "unknown" });
  };

  const submit = handleSubmit(async (values) => {
    setError(null);
    // Sprint Filter ON requires both fields (Edwin, 2026-08-12) — refuse
    // rather than silently saving without the sprint.
    if (
      values.sprintEnabled &&
      (!Number.isInteger(Number.parseInt(values.sprintWeekday, 10)) || !(Number.parseInt(values.sprintLength, 10) > 0))
    ) {
      setError("Sprint Filter needs a start day and a length in days");
      return;
    }
    const isNew = selected === null;
    const result = await save(toRecord(values), isNew).catch((err: unknown): { error?: string } => ({
      error: String(err),
    }));
    if (result.error) {
      setError(result.error);
      return;
    }
    const records = await refresh();
    const saved = records.find((w) => w.name === values.name);
    if (saved) {
      setSelected(saved.name);
      reset(padKeys(toForm(saved)));
    }
  });

  const requestRemoval = (name: string) => setRemoving({ name });

  const confirmRemoval = async () => {
    if (!removing) return;
    const name = removing.name;
    setRemoving((r) => (r ? { ...r, busy: true, error: undefined } : r));
    const result = await remove(name).catch((err: unknown): { outcome?: string; error?: string } => ({
      error: String(err),
    }));
    if (result.error) {
      setRemoving((r) => (r ? { ...r, busy: false, error: result.error } : r));
      return;
    }
    setRemoving(null);
    const records = await refresh();
    if (selected === name) {
      setSelected(null);
      reset(padKeys(blankForm(records.filter((w) => !w.archived).length === 0)));
    }
  };

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      title="Workspaces"
      size="lg"
      isKeyboardDismissDisabled={removing !== null}
    >
      {loadError && <p className="wizard__error">{loadError}</p>}
      <div className="workspace-manager__body">
        {/* left column unchanged — it is a list of buttons, not form fields */}
        <div className="workspace-manager__list">
          <button type="button" className="settings-btn settings-btn--primary settings-btn--wide" onClick={startNew}>
            <Plus size={12} strokeWidth={2.2} /> new workspace
          </button>
          {active.map((ws) => (
            <div key={ws.name} className={`workspace-row${selected === ws.name ? " workspace-row--active" : ""}`}>
              <button type="button" className="workspace-row__pick" onClick={() => selectWorkspace(ws)}>
                <span className="workspace-row__name">{ws.name}</span>
                <span className="workspace-row__meta">
                  {ws.repos.length} repo{ws.repos.length === 1 ? "" : "s"}
                  {ws.default && <span className="sm-chip is-picked">default</span>}
                </span>
              </button>
              <button
                type="button"
                className="workspace-row__remove"
                onClick={() => requestRemoval(ws.name)}
                aria-label={`Remove ${ws.name}`}
              >
                <X size={12} strokeWidth={2} />
              </button>
            </div>
          ))}
          {active.length === 0 && <p className="wizard__hint">No workspaces yet — create one to get started.</p>}
        </div>

        <div className="workspace-manager__form">
          <FormTextField
            control={control}
            name="name"
            label="Workspace name"
            placeholder="acme-web"
            rules={{ validate: filled }}
            isDisabled={selected !== null}
          />
          <FormTextField
            control={control}
            name="description"
            label="Description"
            placeholder="Marketing site + storefront"
          />
          <FormTextField
            control={control}
            name="linksText"
            label="Links"
            hint="one per line — docs, dashboards, tickets"
            placeholder="https://github.com/acme/web"
            multiline
            rows={3}
          />
          <FormColorSwatch control={control} name="color" label="Colour" />
          <div className="workspace-manager__sprint">
            <FormCheckbox control={control} name="sprintEnabled" label="Sprint Filter" />
            {watch("sprintEnabled") && (
              <>
                <FormSelect
                  control={control}
                  name="sprintWeekday"
                  label="Sprint starts on"
                  placeholder="pick a day…"
                  options={WEEKDAYS.map((w) => ({ id: String(w.iso), label: w.label }))}
                />
                <FormTextField control={control} name="sprintLength" label="Sprint length (days)" placeholder="14" />
              </>
            )}
          </div>
          <FormCheckbox
            control={control}
            name="default"
            label="Default workspace — used when a delegation names none"
          />

          <div className="workspace-manager__atlassian">
            <span className="wizard__hint">Atlassian (Jira / Confluence)</span>
            <FormTextField
              control={control}
              name="atlassian.siteUrl"
              labelHidden
              label="Atlassian site URL"
              placeholder="https://acme.atlassian.net"
            />
            <FormSelect
              control={control}
              name="atlassian.connectorId"
              label="Atlassian connector"
              placeholder="pick a connector…"
              options={atlassianConnectors.map((c) => ({ id: c.id, label: c.label }))}
            />
            {/* Index 0 only — entries 1..N ride along untouched. See WorkspaceFormValues. */}
            <FormTextField
              control={control}
              name="atlassian.jiraProjectKeys.0"
              labelHidden
              label="Jira project key"
              placeholder="Jira project key (ACME)"
            />
            <FormTextField
              control={control}
              name="atlassian.confluenceSpaceKeys.0"
              labelHidden
              label="Confluence space key"
              placeholder="Confluence space key (DOCS)"
            />
            {selected && atlassianSiteUrl && (
              <Button variant="secondary" onPress={() => void testAtlassian()} isDisabled={testing === "atlassian"}>
                {testing === "atlassian" ? "testing…" : "Test connection"}
              </Button>
            )}
            {testResult?.target === "atlassian" && (
              <p className={testResult.ok ? "wizard__hint" : "wizard__error"}>{testResult.detail}</p>
            )}
          </div>

          <div className="workspace-manager__repos">
            <span className="wizard__hint">Repos</span>
            {fields.map((field, i) => (
              <div key={field.id} className="repo-row flex flex-wrap items-center gap-2">
                <FormTextField
                  control={control}
                  name={`repos.${i}.name`}
                  label="Repo name"
                  labelHidden
                  placeholder="web"
                  rules={{ validate: filled }}
                />
                <FormTextField
                  control={control}
                  name={`repos.${i}.path`}
                  label="Path"
                  labelHidden
                  placeholder="/Users/me/code/acme-web"
                  rules={{ validate: filled }}
                />
                <FormTextField
                  control={control}
                  name={`repos.${i}.branch`}
                  label="Branch"
                  labelHidden
                  placeholder="main"
                />
                <FormTextField
                  control={control}
                  name={`repos.${i}.owner`}
                  label="GitHub owner"
                  labelHidden
                  placeholder="GitHub owner"
                />
                <FormTextField
                  control={control}
                  name={`repos.${i}.repo`}
                  label="GitHub repo"
                  labelHidden
                  placeholder="GitHub repo"
                />
                <FormSelect
                  control={control}
                  name={`repos.${i}.connectorId`}
                  labelHidden
                  label="GitHub connector"
                  placeholder="pick a connector…"
                  options={githubConnectors.map((c) => ({ id: c.id, label: c.label }))}
                />
                {selected && repoValues[i]?.owner && repoValues[i]?.repo && (
                  <Button
                    variant="secondary"
                    onPress={() => void testRepoGithub(repoValues[i]?.name ?? "")}
                    isDisabled={testing === repoValues[i]?.name}
                  >
                    {testing === repoValues[i]?.name ? "testing…" : "Test"}
                  </Button>
                )}
                <Button
                  isIconOnly
                  variant="ghost"
                  onPress={() => removeRepoAt(i)}
                  isDisabled={fields.length <= 1}
                  aria-label="Remove repo"
                >
                  <X size={12} strokeWidth={2} />
                </Button>
              </div>
            ))}
            <Button variant="secondary" onPress={() => append(emptyRepo())}>
              <Plus size={11} strokeWidth={2.2} /> repo
            </Button>
          </div>

          {error && <p className="wizard__error">{error}</p>}

          <Button variant="primary" onPress={() => void submit()} isDisabled={isSubmitting || !isValid}>
            {isSubmitting ? "saving…" : selected ? "save changes" : "create workspace"}
          </Button>
        </div>
      </div>

      <ConfirmSheet
        open={removing !== null}
        title={`Remove ${removing?.name}?`}
        body="Workspaces that have never hosted a session or task are removed permanently; otherwise this one will be archived and kept for history."
        confirmLabel="remove"
        error={removing?.error}
        busy={removing?.busy}
        onConfirm={() => void confirmRemoval()}
        onCancel={() => setRemoving(null)}
      />
      {groups && saveGroup && deleteGroup && (
        <GroupsSection
          groups={groups}
          workspaces={active.map((w) => w.name)}
          onSave={saveGroup}
          onDelete={deleteGroup}
          autoStart={groupFormIntent}
          onAutoStarted={clearGroupFormIntent}
        />
      )}
    </ModalShell>
  );
}
