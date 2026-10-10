import { ListBox, Select } from "@heroui/react";
import type { DeviceTelemetry } from "../../lib/api";
import { DEFAULT_SIM_KEY, simKey, simSelectChoice, simSelectValue } from "../../lib/simSelection";

type Sim = NonNullable<DeviceTelemetry["smsSubscriptions"]>["items"][number];

function simLabel(sim: Sim): string {
  return `SIM ${sim.slotIndex + 1}`;
}

function SimOption({ name, carrier }: { name: string; carrier: string }) {
  return (
    <span className="sim-option">
      <span className="sim-option__name">{name}</span>
      <span className="sim-option__carrier">{carrier}</span>
    </span>
  );
}

/**
 * §19: HeroUI v3 Select replaces the raw native `<select>`.
 *
 * The `selectedSubscriptionId === null` semantics are preserved exactly: the
 * `default` option maps to `null`, which is what "let the phone pick" means in
 * the command payload. The option is only offered while Android actually
 * reports a default SMS SIM, matching the previous native-select behaviour.
 */
export function SimSelector({
  sims,
  selected,
  onSim,
  useDefault,
  historical = false,
}: {
  sims: Sim[];
  selected?: Sim;
  /** Emits the chosen identity, or null for "let the phone choose". */
  onSim: (choice: { simRef: string } | { subscriptionId: number } | null) => void;
  useDefault: boolean;
  /** True when the list is not current; entries are labelled "Last reported". */
  historical?: boolean;
}) {
  const defaultSim = sims.find((sim) => sim.isDefaultSms);
  const value = simSelectValue(sims, selected, useDefault);
  // "Phone default" is ALWAYS offered: it is the one mode that stays safe and
  // usable when SIM telemetry is stale, because Android resolves the current
  // system default at execution time.
  const defaultCarrier = defaultSim
    ? `SIM ${defaultSim.slotIndex + 1} · ${defaultSim.carrierName || defaultSim.displayName || "Carrier unavailable"}`
    : "Let the phone choose at send time";

  return (
    <Select
      className="sim-select"
      aria-label="Send using SIM"
      placeholder="Choose SIM"
      value={value}
      onChange={(next) => onSim(simSelectChoice(next))}
    >
      <Select.Trigger>
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox>
          <ListBox.Item id={DEFAULT_SIM_KEY} textValue="Phone default">
            <SimOption name="Phone default" carrier={defaultCarrier} />
            <ListBox.ItemIndicator />
          </ListBox.Item>
          {sims.map((sim) => (
            <ListBox.Item key={simKey(sim) ?? simLabel(sim)} id={simKey(sim) ?? ""} textValue={simLabel(sim)}>
              <SimOption
                name={simLabel(sim)}
                carrier={`${sim.carrierName || sim.displayName || "Carrier unavailable"}${
                  historical ? " · Last reported" : ""}`}
              />
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}
