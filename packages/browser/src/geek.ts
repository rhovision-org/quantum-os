// geek.ts — how much of the machinery the page shows.
//
// One setting, three levels, top right of the header:
//
//   low     a room you talk in. Names, people, files, polls, a call. The
//           capability tokens, signaling settings, lemmas, notes, governance
//           and chain tooling are all still there — typed commands work the
//           same — they are just not on screen.
//   medium  the page as it has always been. The default, so nobody's room
//           changes under them.
//   high    reserved for more than medium shows. Today it is medium.
//
// The level is a `data-geek` attribute on <html>, and nearly everything it
// changes is CSS in index.html keyed on that attribute: `.geek-med` marks what
// needs medium or above, `.geek-low` what only low shows. A small inline script
// in <head> sets the attribute before first paint so a "low" page never
// flashes the full one. What CSS cannot do (the call layout, the composer's
// placeholder) is told through `onChange`.
//
// Per browser, not per room: it is a fact about the person, not the room.

export type GeekLevel = "low" | "medium" | "high";

export const GEEK_LEVELS: readonly GeekLevel[] = ["low", "medium", "high"];
export const GEEK_KEY = "qos-geek-level";
export const GEEK_DEFAULT: GeekLevel = "medium";

/** Anything that is not a level is the default — a stale or hand-edited value never breaks the page. */
export function parseGeekLevel(v: unknown): GeekLevel {
  return GEEK_LEVELS.includes(v as GeekLevel) ? (v as GeekLevel) : GEEK_DEFAULT;
}

export function readGeekLevel(): GeekLevel {
  try { return parseGeekLevel(localStorage.getItem(GEEK_KEY)); } catch { return GEEK_DEFAULT; }
}

export interface GeekToggle {
  level(): GeekLevel;
  set(level: GeekLevel): void;
}

const HINTS: Record<GeekLevel, string> = {
  low: "Just the room: people, chat, files and calls",
  medium: "The standard view, with the room's technical details",
  high: "Everything (currently the same as medium)",
};

/** Build the three-way switch into `mount` and apply the stored level. */
export function mountGeekToggle(
  mount: HTMLElement | null,
  onChange: (level: GeekLevel) => void,
): GeekToggle {
  let level = readGeekLevel();
  const buttons = new Map<GeekLevel, HTMLButtonElement>();

  const paint = () => {
    document.documentElement.dataset.geek = level;
    for (const [l, b] of buttons) {
      const on = l === level;
      if (on) b.classList.add("on"); else b.classList.remove("on");
      b.setAttribute("aria-checked", String(on));
    }
  };

  const set = (next: GeekLevel) => {
    if (next === level) return;
    level = next;
    try { localStorage.setItem(GEEK_KEY, level); } catch { /* still applies for this visit */ }
    paint();
    onChange(level);
  };

  if (mount) {
    mount.setAttribute("role", "radiogroup");
    mount.setAttribute("aria-label", "Geek level");
    const cap = document.createElement("span");
    cap.className = "geek-cap";
    cap.textContent = "Geek level";
    mount.appendChild(cap);
    for (const l of GEEK_LEVELS) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "geek-opt";
      b.textContent = l;
      b.title = HINTS[l];
      b.setAttribute("role", "radio");
      b.addEventListener("click", () => set(l));
      buttons.set(l, b);
      mount.appendChild(b);
    }
  }
  paint();
  return { level: () => level, set };
}
