import type { JSX } from "solid-js";
import { For } from "solid-js";
import {
  SegmentedControl,
  SegmentedControlIndicator,
  SegmentedControlItem,
  SegmentedControlItemInput,
  SegmentedControlItemLabel,
  SegmentedControlItems,
  SegmentedControlList,
} from "#components/ui/segmented-control";
import { cn } from "#lib/utils";

export type SegOption<T extends string> = {
  value: T;
  label: JSX.Element;
  title?: string;
};

export type SegControlProps<T extends string> = {
  value: T;
  onChange: (value: T) => void;
  options: readonly SegOption<T>[];
  class?: string;
  "aria-label"?: string;
};

export function SegControl<T extends string>(props: SegControlProps<T>): JSX.Element {
  return (
    <SegmentedControl
      class={cn("w-fit", props.class)}
      orientation="horizontal"
      value={props.value}
      onChange={(next) => {
        props.onChange(next as T);
      }}
      aria-label={props["aria-label"]}
    >
      <SegmentedControlList>
        <SegmentedControlIndicator />
        <SegmentedControlItems>
          <For each={props.options}>
            {(option) => (
              <SegmentedControlItem value={option.value} title={option.title}>
                <SegmentedControlItemInput />
                <SegmentedControlItemLabel>{option.label}</SegmentedControlItemLabel>
              </SegmentedControlItem>
            )}
          </For>
        </SegmentedControlItems>
      </SegmentedControlList>
    </SegmentedControl>
  );
}
