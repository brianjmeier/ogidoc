import { createSignal } from "solid-js";

export type Confirmed = ReturnType<typeof confirmed>;

// An action that is hard to take back runs on the second click within 3 seconds.
export function confirmed(run: () => unknown) {
  const [armed, setArmed] = createSignal(false);
  let disarm: ReturnType<typeof setTimeout> | undefined;
  return {
    armed,
    click() {
      clearTimeout(disarm);
      if (!armed()) {
        setArmed(true);
        disarm = setTimeout(() => setArmed(false), 3000);
        return;
      }
      setArmed(false);
      run();
    },
  };
}
