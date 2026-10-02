import { ListBox, Select } from "@heroui/react";
import type { DeviceTelemetry } from "../../lib/api";
import { DEFAULT_SIM_KEY, simSelectChoice, simSelectValue } from "../../lib/simSelection";

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
}: {
  sims: Sim[];
  selected?: Sim;
  onSim: (id: number | null) => void;
  useDefault: boolean;
}) {
  if (sims.length === 0) return null;

  const defaultSim = sims.find((sim) => sim.isDefaultSms);
  const value = simSelectValue(sims, selected, useDefault);

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
          {defaultSim ? (
            <ListBox.Item id={DEFAULT_SIM_KEY} textValue="Default">
              <SimOption
                name="Default"
                carrier={`SIM ${defaultSim.slotIndex + 1} · ${
                  defaultSim.carrierName || defaultSim.displayName || "Carrier unavailable"
                }`}
              />
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ) : null}
          {sims.map((sim) => (
            <ListBox.Item key={sim.subscriptionId} id={String(sim.subscriptionId)} textValue={simLabel(sim)}>
              <SimOption
                name={simLabel(sim)}
                carrier={sim.carrierName || sim.displayName || "Carrier unavailable"}
              />
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}
