import { Button } from "@heroui/react";
import { RadioButtonGroup, Stepper } from "@heroui-pro/react";
import { Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { type FieldPath, useFieldArray, useForm, useWatch } from "react-hook-form";
import type { ConnectorInstanceRecord, WorkspaceRecord } from "../api/types";
import {
  FormColorSwatch,
  FormSelect,
  FormTextField,
  ModalShell,
  SprintFilterFields,
  sprintFromForm,
} from "../molecules/form";

interface DraftRepo {
  /** Both modes converge on `path`; only the source of the value differs (design §4). */
  mode: "existing" | "new";
  name: string;
  path: string;
  owner: string;
  repo: string;
  connectorId: string;
}

interface NewContextFormValues {
  /** The group attribute made concrete (spec 2026-08-13): what this context
      CONTAINS decides what it is — repos make a workspace, members make a group. */
  contains: "repos" | "members";
  name: string;
  description: string;
  linksText: string;
  color: string;
  /** The Sprint Filter toggle (date-range spec 2026-08-12) — ON requires a start day and a length. */
  sprintEnabled: boolean;
  sprintWeekday: string; // "" | "1".."7" (ISO Mon..Sun)
  sprintLength: string;
  repos: DraftRepo[];
  memberWorkspaces: string[];
  memberGroups: string[];
}

const emptyRepo = (): DraftRepo => ({ mode: "existing", name: "", path: "", owner: "", repo: "", connectorId: "" });

const blankForm = (): NewContextFormValues => ({
  contains: "repos",
  name: "",
  description: "",
  linksText: "",
  color: "",
  sprintEnabled: false,
  sprintWeekday: "",
  sprintLength: "",
  repos: [emptyRepo()],
  memberWorkspaces: [],
  memberGroups: [],
});

/** Non-blank after trimming — every gate in this form is that same check. */
const filled = (v: string) => v.trim().length > 0;

/**
 * Repo-row rules auto-pass in members mode (spec 2026-08-13's validation
 * trap): the hidden, empty repo fields would otherwise pin `isValid` false
 * forever and a group could never be created. RHF hands validate() the whole
 * form's values, which is what makes the rule mode-aware without re-registering.
 */
const repoFieldRule = {
  validate: (v: unknown, all: NewContextFormValues) => all.contains === "members" || filled(String(v ?? "")),
};

/**
 * The wizard's three steps and the fields each one gates on.
 *
 * `gates` lists the fields RHF must find valid before `next` enables. Repos are
 * absent from every entry on purpose: they are a field array whose length changes
 * at runtime, so the last step gates on `isValid` for the whole form instead —
 * which is exactly what the single-page version's create button already did.
 */
const STEPS = [
  { title: "Details", description: "Name and links", gates: ["name"] },
  { title: "Colour", description: "Optional identity", gates: [] },
  { title: "Repos", description: "At least one", gates: [] },
] as const satisfies ReadonlyArray<{
  title: string;
  description: string;
  gates: ReadonlyArray<FieldPath<NewContextFormValues>>;
}>;

interface NewContextModalProps {
  open: boolean;
  onClose: () => void;
  /** POST /workspaces via the broker proxy — same function WorkspaceManagerModal uses. */
  save: (ws: WorkspaceRecord, isNew: boolean) => Promise<{ error?: string; name?: string }>;
  listMyConnectors: () => Promise<ConnectorInstanceRecord[]>;
  /** The session's current workspace name, if any. */
  activeWorkspace?: string;
  /** Native folder picker — absent outside the Tauri shell (Task 7 renders Browse only when provided). */
  pickFolder?: () => Promise<string | null>;
  /** Called with the created (server-slugged) workspace name — the caller creates + activates the first session. */
  onCreated: (name: string) => void;
  /** Member pickers for the group half of the fork. */
  workspaces: string[];
  groups: Array<{ name: string }>;
  /** POST /groups via the broker proxy — the same function the manager passes. */
  saveGroup: (
    body: {
      name: string;
      description?: string;
      color?: string;
      workspaces: string[];
      groups: string[];
      sprint?: { anchor: string; lengthDays: number };
    },
    isNew: boolean,
  ) => Promise<{ error?: string }>;
}

export function NewContextModal({
  open,
  onClose,
  save,
  listMyConnectors,
  pickFolder,
  onCreated,
  workspaces,
  groups,
  saveGroup,
}: NewContextModalProps) {
  const [connectors, setConnectors] = useState<ConnectorInstanceRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState(0);
  const detailsRef = useRef<HTMLDivElement>(null);
  const colourRef = useRef<HTMLDivElement>(null);
  const reposRef = useRef<HTMLDivElement>(null);
  const membersRef = useRef<HTMLDivElement>(null);

  // mode: "onChange" because the create button gates on isValid; under the default
  // onSubmit mode isValid would stay false until a submit that can never happen.
  const {
    control,
    handleSubmit,
    register,
    reset,
    setValue,
    watch,
    trigger,
    formState: { isValid, isSubmitting },
  } = useForm<NewContextFormValues>({ mode: "onChange", defaultValues: blankForm() });
  const { fields, append, remove } = useFieldArray({ control, name: "repos" });

  // HomePage keeps this modal mounted and toggles `open`, so useForm's per-mount
  // defaults only ever run once — reopening has to reset explicitly.
  // biome-ignore lint/correctness/useExhaustiveDependencies: open-keyed reset, same pattern as WorkspaceManagerModal
  useEffect(() => {
    if (!open) return;
    reset(blankForm());
    setStep(0);
    setError(null);
    void listMyConnectors().then(setConnectors);
  }, [open]);

  const githubConnectors = connectors.filter((c) => c.vendorId === "github");

  // Only the repo `mode` needs watching for render: it swaps the path placeholder and
  // the Browse button. Everything else is uncontrolled and read at submit.
  const repoModes = watch("repos");
  // The containment fork (spec 2026-08-13): what this contains decides what
  // it IS — "workspace that add child workspace or other groups is a group".
  const contains = watch("contains");
  const isGroup = contains === "members";

  // Watched values, not formState.errors: errors only exist after a validation run,
  // so gating on them would leave `next` enabled on a pristine form — exactly the
  // state the first new test exercises. `useWatch` re-renders on every keystroke,
  // which is what makes the button enable as soon as the field is filled.
  const values = useWatch({ control });
  const canLeaveStep = STEPS[step].gates.every((g) => filled(String(values[g] ?? "")));

  const goNext = async () => {
    const gates = STEPS[step].gates;
    // A step with no gates (Colour) is always passable. `trigger([])` returns
    // true for an empty list, but calling it at all is wasted work.
    if (gates.length > 0 && !(await trigger([...gates]))) return;
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  };

  // Move focus into the step whenever it changes. Without this, clicking `back` to
  // a lower step disables the very button holding focus — isDisabled becomes the
  // native `disabled` attribute, and a real browser blurs a focused element the
  // instant it's disabled, dropping focus to <body>. That escapes the dialog's
  // focus trap and silently kills ESC: caught only by manual smoke against a live
  // browser. jsdom does not model that blur (verified directly — a focused
  // element's activeElement survives `.disabled = true` unchanged), so no test
  // could have caught it by construction. This also announces the new step to
  // screen readers, which the stepper alone does not do.
  useEffect(() => {
    const stepEls = [detailsRef.current, colourRef.current, isGroup ? membersRef.current : reposRef.current];
    const first = stepEls[step]?.querySelector<HTMLElement>(
      'input:not([disabled]), textarea, [role="listbox"], button:not([disabled])',
    );
    // preventScroll: the modal is TOP-ANCHORED now (Edwin, 2026-08-13) and
    // the first control is always near the step's top — an autoscroll here
    // just ate the anchor margin and yanked the dialog to the viewport edge.
    first?.focus({ preventScroll: true });
  }, [step, isGroup]);

  const browse = async (index: number) => {
    if (!pickFolder) return;
    const picked = await pickFolder();
    if (picked) setValue(`repos.${index}.path`, picked, { shouldValidate: true });
  };

  const submit = handleSubmit(async (values) => {
    setError(null);
    // The SHARED submit rule (sprintFromForm): refuse a half-configured sprint.
    const sprintCheck = sprintFromForm(values);
    if ("error" in sprintCheck) {
      setError(sprintCheck.error);
      return;
    }
    if (values.contains === "members") {
      // The group half of the fork: same body the manager's form posts. A
      // created group needs no onCreated — the groups frame lands on the
      // socket and the droplist shows it.
      const r = await saveGroup(
        {
          name: values.name.trim(),
          description: values.description.trim() || undefined,
          color: values.color || undefined,
          sprint: sprintCheck.sprint,
          // RHF yields false (not []) when every checkbox is unchecked.
          workspaces: Array.isArray(values.memberWorkspaces) ? values.memberWorkspaces : [],
          groups: Array.isArray(values.memberGroups) ? values.memberGroups : [],
        },
        true,
      ).catch((err: unknown) => ({ error: String(err) }));
      if (r.error) {
        setError(r.error);
        return;
      }
      onClose();
      return;
    }
    const record: WorkspaceRecord = {
      name: values.name.trim(),
      default: false, // the first-ever workspace defaults itself server-side
      description: values.description.trim(),
      color: values.color || undefined,
      links: values.linksText
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean),
      sprint: sprintCheck.sprint,
      repos: values.repos.map((r) => ({
        name: r.name.trim(),
        path: r.path.trim(),
        branch: "main",
        github: { owner: r.owner.trim(), repo: r.repo.trim(), connectorId: r.connectorId },
        ...(r.mode === "new" ? { initGit: true } : {}),
      })),
    };
    const result = await save(record, true).catch((err: unknown): { error?: string; name?: string } => ({
      error: String(err),
    }));
    if (result.error) {
      setError(result.error);
      return;
    }
    // The server slugs the name ("My App" -> "my-app") — the first session must target the saved name.
    onCreated(result.name ?? record.name);
    onClose();
  });

  const isLastStep = step === STEPS.length - 1;

  return (
    <ModalShell open={open} onClose={onClose} title="New workspace or group">
      <Stepper currentStep={step}>
        {STEPS.map((s, i) => (
          <Stepper.Step key={s.title}>
            <Stepper.Indicator />
            <Stepper.Content>
              <Stepper.Title>{i === 2 && isGroup ? "Members" : s.title}</Stepper.Title>
              <Stepper.Description>{i === 2 && isGroup ? "Workspaces & groups" : s.description}</Stepper.Description>
            </Stepper.Content>
            <Stepper.Separator />
          </Stepper.Step>
        ))}
      </Stepper>

      {/* Every step's fields stay MOUNTED and are hidden with `hidden`, never
          unmounted. NOT because unmounting would clear the value today — verified
          directly: RHF v7 defaults `shouldUnregister` to false, and under that default
          a field's cleanup effect only flips its internal mount flag (`control.register`'s
          teardown calls `updateMounted(name, false)`, never `control.unregister(name)`),
          so `control._formValues` is untouched and a real conditional-unmount/remount
          preserves the typed value too. `hidden` is still the right call regardless: it
          keeps this correct without depending on that default staying what it is — on
          `useForm`, per-field on `useController`, or in a future RHF major. The `back`
          test asserts the value survives; it doesn't distinguish which mechanism did it. */}
      <div ref={detailsRef} hidden={step !== 0}>
        {/* What does this contain? The answer IS the entity (Edwin: "workspace
            that add child workspace or other groups is a group"). The pills
            carry NO indicator dot — the selected outline is the state, and
            the dot rendered floating over the label text (Edwin's screenshot,
            2026-08-13). */}
        <div className="nc-contains">
          <span className="nc-contains__label" id="nc-contains-label">
            What does this contain?
          </span>
          <RadioButtonGroup
            aria-labelledby="nc-contains-label"
            value={contains}
            onChange={(value) => setValue("contains", value as NewContextFormValues["contains"])}
            orientation="horizontal"
          >
            <RadioButtonGroup.Item value="repos">
              <RadioButtonGroup.ItemContent>Repositories</RadioButtonGroup.ItemContent>
            </RadioButtonGroup.Item>
            <RadioButtonGroup.Item value="members">
              <RadioButtonGroup.ItemContent>Workspaces &amp; groups</RadioButtonGroup.ItemContent>
            </RadioButtonGroup.Item>
          </RadioButtonGroup>
        </div>
        <FormTextField
          control={control}
          name="name"
          label={isGroup ? "Group name" : "Workspace name"}
          placeholder={isGroup ? "frontend" : "acme"}
          rules={{ validate: filled }}
        />
        <FormTextField
          control={control}
          name="description"
          label="Description"
          placeholder="Marketing site + storefront"
        />
        {/* Groups carry no links field — hidden beats silently dropping typed input. */}
        <div hidden={isGroup}>
          <FormTextField
            control={control}
            name="linksText"
            label="Links"
            hint="one per line — docs, dashboards, tickets"
            multiline
            rows={3}
          />
        </div>
        {/* SHARED Sprint Filter — the same component the manager and group editor render. */}
        <SprintFilterFields control={control} />
      </div>

      <div ref={colourRef} hidden={step !== 1}>
        <FormColorSwatch control={control} name="color" label="Colour" />
      </div>

      <div ref={reposRef} hidden={step !== 2 || isGroup}>
        <p className="wizard__hint">Repos — every repo needs a GitHub connector before create enables.</p>
        {githubConnectors.length === 0 && (
          <p className="wizard__hint">No GitHub connectors yet — add one in Settings → Integrations first.</p>
        )}
        {fields.map((field, i) => (
          <div key={field.id} className="nw-repo-row">
            {/* `value` / `onChange(value: string)` and `Item value=` are VERIFIED against
                the docs' Controlled example. `orientation` is VERIFIED too, by reading the
                installed source: RadioButtonGroupRoot spreads its remaining props (which
                include `orientation`) straight onto `RadioGroup`, and @heroui/styles'
                radio-group.css keys `flex-row` off `[data-orientation="horizontal"]` —
                the Pro component's own prop table just doesn't repeat inherited props. */}
            <RadioButtonGroup
              aria-label={`Repo ${i + 1} source`}
              value={repoModes[i]?.mode ?? "existing"}
              onChange={(value) => setValue(`repos.${i}.mode`, value as DraftRepo["mode"])}
              orientation="horizontal"
            >
              <RadioButtonGroup.Item value="existing">
                <RadioButtonGroup.ItemContent>Existing repo</RadioButtonGroup.ItemContent>
              </RadioButtonGroup.Item>
              <RadioButtonGroup.Item value="new">
                <RadioButtonGroup.ItemContent>New folder</RadioButtonGroup.ItemContent>
              </RadioButtonGroup.Item>
            </RadioButtonGroup>
            <FormTextField
              control={control}
              name={`repos.${i}.name`}
              label="Repo name"
              labelHidden
              placeholder="web"
              rules={repoFieldRule}
            />
            <FormTextField
              control={control}
              name={`repos.${i}.path`}
              labelHidden
              label="Path"
              placeholder={repoModes[i]?.mode === "new" ? "/Users/me/code/new-project" : "/Users/me/code/acme-web"}
              rules={repoFieldRule}
            />
            {repoModes[i]?.mode === "new" && pickFolder && (
              <Button variant="secondary" onPress={() => void browse(i)}>
                Browse…
              </Button>
            )}
            <FormTextField
              control={control}
              name={`repos.${i}.owner`}
              label="GitHub owner"
              labelHidden
              placeholder="GitHub owner"
              rules={repoFieldRule}
            />
            <FormTextField
              control={control}
              name={`repos.${i}.repo`}
              label="GitHub repo"
              labelHidden
              placeholder="GitHub repo"
              rules={repoFieldRule}
            />
            <FormSelect
              control={control}
              name={`repos.${i}.connectorId`}
              labelHidden
              label="GitHub connector"
              placeholder="pick a connector…"
              options={githubConnectors.map((c) => ({ id: c.id, label: c.label }))}
              rules={{ validate: (v, all) => all.contains === "members" || Boolean(v) }}
            />
            <Button
              isIconOnly
              variant="ghost"
              onPress={() => remove(i)}
              isDisabled={fields.length <= 1}
              aria-label="Remove repo"
            >
              <X size={12} strokeWidth={2} />
            </Button>
          </div>
        ))}
        <Button variant="secondary" onPress={() => append(emptyRepo())}>
          <Plus size={11} strokeWidth={2.2} /> add another
        </Button>
      </div>

      {/* The members pane — the containment that MAKES this a group. All
          contexts are offered: a new context can't be its own ancestor, so
          no cycle filter applies on create. Empty selection is legal, same
          as the manager's group form. */}
      <div ref={membersRef} hidden={step !== 2 || !isGroup}>
        <fieldset className="groups-section__members">
          <legend>Member workspaces</legend>
          {workspaces.map((ws) => (
            <label key={ws} className="groups-section__member">
              <input type="checkbox" value={ws} {...register("memberWorkspaces")} />
              {ws}
            </label>
          ))}
          {workspaces.length === 0 && <p className="wizard__hint">No workspaces yet.</p>}
        </fieldset>
        <fieldset className="groups-section__members">
          <legend>Member groups</legend>
          {groups.map((g) => (
            <label key={g.name} className="groups-section__member">
              <input type="checkbox" value={g.name} {...register("memberGroups")} />
              {g.name}
            </label>
          ))}
          {groups.length === 0 && <p className="wizard__hint">No groups yet.</p>}
        </fieldset>
      </div>

      {error && <p className="wizard__error">{error}</p>}

      {/* One footer for all three steps. `create workspace` renders only on the
          last step — a stepper that offered submit from step 0 would POST a
          half-filled workspace, which is what the third new test guards.
          `nw-wizard__nav` never had a rule in components.css (a doomed file —
          scheduled for deletion in Phase 3) and never will; Tailwind utilities
          directly on the element instead. */}
      <div className="mt-4 flex items-center justify-between gap-3">
        <Button variant="secondary" onPress={() => setStep((s) => Math.max(s - 1, 0))} isDisabled={step === 0}>
          back
        </Button>
        {isLastStep ? (
          <Button variant="primary" onPress={() => void submit()} isDisabled={isSubmitting || !isValid}>
            {isSubmitting ? "creating…" : isGroup ? "create group" : "create workspace"}
          </Button>
        ) : (
          <Button variant="primary" onPress={() => void goNext()} isDisabled={!canLeaveStep}>
            next
          </Button>
        )}
      </div>
    </ModalShell>
  );
}
