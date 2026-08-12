import { Label, ListBox, Select } from "@heroui/react";
import { useState } from "react";
import type { GroupT } from "../api/types";
import { type DateRange, rangeLabel, sprintConfigFor } from "../lib/dateRange";
import { useWorkspaceRecords } from "../queries/http";
import { useGroups, useSession } from "../queries/pushed";
import { useUiStore } from "../stores/uiStore";

const NO_GROUPS: GroupT[] = [];

// Sentinel-keyed commands/values (workspace selector precedent): option ids
// never collide with data.
const ALL_TIME = "__all-time__";
const CUSTOM = "__custom__";

const PERIODS: Array<{ id: string; range: DateRange }> = [
  { id: "week", range: { kind: "week" } },
  { id: "sprint", range: { kind: "sprint" } },
  { id: "month", range: { kind: "month" } },
  { id: "quarter", range: { kind: "quarter" } },
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
  // Deferred like every workspace-record probe (HomePage holds them until a
  // surface needs them): the records fetch only once the menu first opens —
  // that is the moment "is there a sprint config?" starts mattering.
  const [opened, setOpened] = useState(false);
  const { data: workspaceRecords = [] } = useWorkspaceRecords(opened);
  const activeLens = useUiStore((s) => s.activeLens);
  const dateRange = useUiStore((s) => s.dateRange);
  const setDateRange = useUiStore((s) => s.setDateRange);
  const [customOpen, setCustomOpen] = useState(false);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const lensGroup = activeLens ? groups.find((g) => g.name === activeLens.group) : undefined;
  const workspace = workspaceRecords.find((w) => w.name === session?.workspace);
  const sprint = sprintConfigFor(lensGroup, workspace);

  // A picked sprint whose config left (workspace switch) DISPLAYS as All time
  // without writing the store — the choice comes back if the config does.
  const effective = dateRange?.kind === "sprint" && !sprint ? null : dateRange;

  const value = effective === null ? ALL_TIME : effective.kind === "custom" ? CUSTOM : effective.kind;

  const pick = (key: string) => {
    if (key === ALL_TIME) {
      setCustomOpen(false);
      setDateRange(null);
      return;
    }
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
          <span className="date-range__value">{rangeLabel(effective)}</span>
          <Select.Indicator />
        </Select.Trigger>
        <Select.Popover>
          <ListBox>
            <ListBox.Item id={ALL_TIME} textValue="All time">
              All time
              <ListBox.ItemIndicator />
            </ListBox.Item>
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
