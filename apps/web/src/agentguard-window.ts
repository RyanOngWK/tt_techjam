export type WindowGeometry = {
  x: number;
  y: number;
  w: number;
  h: number;
};

export type ResizeCorner = "nw" | "ne" | "sw" | "se";

export const AGENTGUARD_WINDOW_STORAGE_KEY = "agentguard-window";

export const MIN_WINDOW_WIDTH = 420;
export const MIN_WINDOW_HEIGHT = 260;
export const WINDOW_MARGIN = 12;

export function defaultGeometry(
  viewportWidth = typeof window !== "undefined" ? window.innerWidth : 1280,
  viewportHeight = typeof window !== "undefined" ? window.innerHeight : 800,
): WindowGeometry {
  const w = Math.min(640, Math.max(MIN_WINDOW_WIDTH, viewportWidth - WINDOW_MARGIN * 2));
  const h = Math.min(360, Math.max(MIN_WINDOW_HEIGHT, Math.floor(viewportHeight * 0.4)));
  return {
    w,
    h,
    x: Math.max(WINDOW_MARGIN, viewportWidth - w - WINDOW_MARGIN),
    y: Math.max(WINDOW_MARGIN, viewportHeight - h - WINDOW_MARGIN),
  };
}

export function clampRect(
  rect: WindowGeometry,
  viewportWidth = typeof window !== "undefined" ? window.innerWidth : 1280,
  viewportHeight = typeof window !== "undefined" ? window.innerHeight : 800,
): WindowGeometry {
  const maxW = Math.max(MIN_WINDOW_WIDTH, viewportWidth - WINDOW_MARGIN * 2);
  const maxH = Math.max(MIN_WINDOW_HEIGHT, viewportHeight - WINDOW_MARGIN * 2);
  const w = Math.min(Math.max(rect.w, MIN_WINDOW_WIDTH), maxW);
  const h = Math.min(Math.max(rect.h, MIN_WINDOW_HEIGHT), maxH);
  const maxX = Math.max(WINDOW_MARGIN, viewportWidth - w - WINDOW_MARGIN);
  const maxY = Math.max(WINDOW_MARGIN, viewportHeight - h - WINDOW_MARGIN);
  return {
    w,
    h,
    x: Math.min(Math.max(rect.x, WINDOW_MARGIN), maxX),
    y: Math.min(Math.max(rect.y, WINDOW_MARGIN), maxY),
  };
}

/** Resize from a corner drag; keeps the opposite corner anchored. */
export function resizeFromCorner(
  origin: WindowGeometry,
  dx: number,
  dy: number,
  corner: ResizeCorner,
): WindowGeometry {
  let left = origin.x;
  let top = origin.y;
  let right = origin.x + origin.w;
  let bottom = origin.y + origin.h;

  switch (corner) {
    case "se":
      right += dx;
      bottom += dy;
      break;
    case "sw":
      left += dx;
      bottom += dy;
      break;
    case "ne":
      right += dx;
      top += dy;
      break;
    case "nw":
      left += dx;
      top += dy;
      break;
  }

  if (right - left < MIN_WINDOW_WIDTH) {
    if (corner === "se" || corner === "ne") {
      right = left + MIN_WINDOW_WIDTH;
    } else {
      left = right - MIN_WINDOW_WIDTH;
    }
  }
  if (bottom - top < MIN_WINDOW_HEIGHT) {
    if (corner === "se" || corner === "sw") {
      bottom = top + MIN_WINDOW_HEIGHT;
    } else {
      top = bottom - MIN_WINDOW_HEIGHT;
    }
  }

  return clampRect({
    x: left,
    y: top,
    w: right - left,
    h: bottom - top,
  });
}

export function loadGeometry(): WindowGeometry {
  try {
    const raw = localStorage.getItem(AGENTGUARD_WINDOW_STORAGE_KEY);
    if (!raw) return clampRect(defaultGeometry());
    const parsed = JSON.parse(raw) as Partial<WindowGeometry>;
    if (
      typeof parsed.x !== "number" ||
      typeof parsed.y !== "number" ||
      typeof parsed.w !== "number" ||
      typeof parsed.h !== "number"
    ) {
      return clampRect(defaultGeometry());
    }
    return clampRect({
      x: parsed.x,
      y: parsed.y,
      w: parsed.w,
      h: parsed.h,
    });
  } catch {
    return clampRect(defaultGeometry());
  }
}

export function saveGeometry(rect: WindowGeometry): void {
  try {
    localStorage.setItem(
      AGENTGUARD_WINDOW_STORAGE_KEY,
      JSON.stringify(clampRect(rect)),
    );
  } catch {
    // Ignore quota / private mode failures.
  }
}
