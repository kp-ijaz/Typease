import * as React from 'react';

/**
 * Is a mouse button / finger down right now? Tracked once for the whole
 * document (capture phase, so nothing can stop it from being seen).
 */
let pressing = false;
let tracking = false;
function track() {
  if (tracking || typeof window === 'undefined') return;
  tracking = true;
  const down = () => {
    pressing = true;
  };
  const up = () => {
    pressing = false;
  };
  window.addEventListener('pointerdown', down, true);
  window.addEventListener('pointerup', up, true);
  window.addEventListener('pointercancel', up, true);
  window.addEventListener('dragend', up, true);
  window.addEventListener('blur', up);
}

/**
 * Returns `value`, except that a CHANGE which arrives while the pointer is
 * down is held back until the press is over.
 *
 * Why: a click is a press and a release on the same element. Pressing a button
 * blurs the field that had focus; if that blur makes a validation message
 * appear, everything below it moves, the release lands on something else and
 * the browser discards the click. Content that appears because of a blur must
 * therefore wait for the release. (Keyboard users are not delayed at all.)
 */
export function useHeldWhilePressing<T>(value: T): T {
  track();
  const [, rerender] = React.useReducer((n: number) => n + 1, 0);
  const shown = React.useRef(value);
  if (!pressing) shown.current = value;

  React.useEffect(() => {
    if (Object.is(shown.current, value)) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const release = () => {
      // After the click that follows the release has been dispatched.
      timer = setTimeout(() => {
        shown.current = value;
        rerender();
      }, 0);
    };
    window.addEventListener('pointerup', release, true);
    window.addEventListener('pointercancel', release, true);
    // A press that never ends for us (released outside the window): do not hold the message for ever.
    const safety = setTimeout(release, 1500);
    return () => {
      window.removeEventListener('pointerup', release, true);
      window.removeEventListener('pointercancel', release, true);
      clearTimeout(safety);
      if (timer) clearTimeout(timer);
    };
  }, [value]);

  return shown.current;
}
