import { Label, ListBox, Select } from "@heroui/react";
import { useState } from "react";
import type { GroupT } from "../api/types";
import {
  type DateRange,
  effectiveRange,
  formatBounds,
  rangeLabel,
  resolveDateRange,
  sprintConfigFor,
} from "../lib/dateRange";
import { useWorkspaceRecords } from "../queries/http";
import { useGroups, useSession } from "../queries/pushed";
import { useUiStore } from "../stores/uiStore";

const NO_GROUPS: GroupT[] = [];

// Sentinel-keyed commands/values (workspace selector precedent): option ids
// never collide with data.
const CUSTOM = "__custom__";

// No "All time" (Edwin, 2026-08-12): the app is always windowed. Sprint leads
// when configured; the rolling windows are the plain-calendar fallbacks.
const PERIODS: Array<{ id: string; range: DateRange }> = [
  { id: "sprint", range: { kind: "sprint" } },
  { id: "week", range: { kind: "week" } },
  { id: "month", range: { kind: "month" } },
  { id: "quarter", range: { kind: "quarter" } },
  { id: "days-14", range: { kind: "days", days: 14 } },
  { id: "days-30", range: { kind: "days", days: 30 } },
];

/**
 * The WHEN half of the context window (date-range spec 2026-08-12), beside the
 * workspace/group selector. Current Sprint is OPT-IN: it renders only when the
 * active context (group lens first, then the session's workspace) carries a
 * sprint config — an unconfigured context has no sprints to be current in.
 */
export function DateRangeSelect() {
  const { data: session } = useSession();
  const { data: groups = NO_GROUPS } = useGroups();
  const [opened, setOpened] = useState(false);
  const activeLens = useUiStore((s) => s.activeLens);
  const dateRange = useUiStore((s) => s.dateRange);
  // The records probe runs at boot whenever sprint is the stored OR defaulted
  // choice — the trigger's very first label depends on whether a config
  // resolves. Otherwise it still defers to the first menu open.
  const { data: workspaceRecords = [] } = useWorkspaceRecords(opened || !dateRange || dateRange.kind === "sprint");
  const setDateRange = useUiStore((s) => s.setDateRange);
  const [customOpen, setCustomOpen] = useState(false);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const lensGroup = activeLens ? groups.find((g) => g.name === activeLens.group) : undefined;
  const workspace = workspaceRecords.find((w) => w.name === session?.workspace);
  const sprint = sprintConfigFor(lensGroup, workspace);

  // Sprint-if-configured, last-14 otherwise (and a picked sprint whose config
  // left degrades the same way) — without writing the store, so the choice
  // comes back if the config does.
  const effective = effectiveRange(dateRange, sprint);

  const value =
    effective.kind === "custom" ? CUSTOM : effective.kind === "days" ? `days-${effective.days}` : effective.kind;

  // The trigger presents the RESOLVED dates inline (Edwin, 2026-08-12): the
  // period name plus its concrete window — custom shows only the dates, since
  // its name IS the dates.
  const bounds = resolveDateRange(effective, new Date(), sprint);
  const triggerText = !bounds
    ? rangeLabel(effective)
    : effective.kind === "custom"
      ? formatBounds(bounds, new Date())
      : `${rangeLabel(effective)} · ${formatBounds(bounds, new Date())}`;

  const pick = (key: string) => {
    if (key === CUSTOM) {
      setCustomOpen(true); // applied by the popover's Apply, not the pick
      return;
    }
    const period = PERIODS.find((p) => p.id === key);
    if (period) {
      setCustomOpen(false);
      setDateRange(period.range);
    }
  };

  return (
    <span className="date-range">
      <Select
        className="date-range__select"
        variant="secondary"
        value={value}
        onOpenChange={(open) => open && setOpened(true)}
        onChange={(key) => {
          if (key != null) pick(String(key));
        }}
      >
        <Label className="sr-only">Date range</Label>
        {/* The trigger's accessible NAME stays "Date range" (react-aria wires
            labelledby to the Label); the VALUE is this span's text — a custom
            range reads as its dates, not "custom". */}
        <Select.Trigger>
          <span className="date-range__value">{triggerText}</span>
          <Select.Indicator />
        </Select.Trigger>
        <Select.Popover>
          <ListBox>
            {PERIODS.filter((p) => p.id !== "sprint" || sprint).map((p) => (
              <ListBox.Item key={p.id} id={p.id} textValue={rangeLabel(p.range)}>
                {rangeLabel(p.range)}
                <ListBox.ItemIndicator />
              </ListBox.Item>
            ))}
            <ListBox.Item id={CUSTOM} textValue="Custom range…">
              Custom range…
            </ListBox.Item>
          </ListBox>
        </Select.Popover>
      </Select>
      {customOpen && (
        <div className="date-range__custom">
          <label className="date-range__field">
            From
            <input type="date" aria-label="From" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className="date-range__field">
            To
            <input type="date" aria-label="To" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
          <button
            type="button"
            className="settings-btn settings-btn--primary"
            disabled={!from || !to}
            onClick={() => {
              setDateRange({ kind: "custom", from, to });
              setCustomOpen(false);
            }}
          >
            Apply
          </button>
        </div>
      )}
    </span>
  );
}
