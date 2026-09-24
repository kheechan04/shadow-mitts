// Local game records (M4). Only game numbers are kept — scores, combos, per-punch hits — never
// video, poses or faces. Storage can fail (private mode, disabled storage): the game then just
// runs without history (DESIGN §6: "localStorage는 실패해도 앱이 동작하게").

import { emptyProgress, sanitizeProgress, type Progress } from '../core/progress';

const KEY = 'shadowmitts.progress.v1';

export function loadProgress(): Progress {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? sanitizeProgress(JSON.parse(raw)) : emptyProgress();
  } catch {
    return emptyProgress();
  }
}

/** false when the browser refused to store it (the game goes on either way) */
export function saveProgress(p: Progress): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
    return true;
  } catch {
    return false;
  }
}

export function clearProgress(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // nothing stored, nothing to clear
  }
}
