// The game's phase: the one value that says what the game as a whole is doing.
//
//   boot    -> title | garage | driving | error
//   title   -> garage | driving | error
//   garage  -> driving | title | error      (the room where the car is chosen: design/GARAGE.md)
//   driving -> paused | title | garage | error
//   paused  -> driving | title | garage | error
//   error   is final
//
// Other modules read `phase.name`; only game.js and main.js change it, through `to()`, which
// refuses moves that the table above does not allow, so that a late callback (a menu action
// arriving after a fatal error, a resume after quitting) cannot put the game in a state it
// cannot be in.

export const PHASES = Object.freeze(['boot', 'title', 'garage', 'driving', 'paused', 'error']);

const ALLOWED = Object.freeze({
  boot: ['title', 'garage', 'driving', 'error'],
  title: ['garage', 'driving', 'error'],
  garage: ['driving', 'title', 'error'],
  driving: ['paused', 'title', 'garage', 'error'],
  paused: ['driving', 'title', 'garage', 'error'],
  error: [],
});

/**
 * @param {(next: string, previous: string) => void} [onChange]
 */
export function createPhase(onChange) {
  const phase = {
    name: 'boot',
    /** Moves to `next` if that is allowed from the current phase. Returns whether it moved. */
    to(next) {
      if (!ALLOWED[phase.name].includes(next)) return false;
      const previous = phase.name;
      phase.name = next;
      if (onChange) onChange(next, previous);
      return true;
    },
    /** True while simulated time passes. */
    get running() { return phase.name === 'title' || phase.name === 'garage' || phase.name === 'driving'; },
  };
  return phase;
}
