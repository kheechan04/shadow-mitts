import { PARAM_DEFS, defaultParams, sanitizeParams, type ParamKey, type Params } from '../core/params';

// v1 stored EVERY value once any slider moved, so later default changes never reached that
// browser (the play-tester's game still ran punchMaxRiseMs 350 after the default became 480; a
// replay with 350 matched the live judgements 34/34). v2 stores only values that differ from the
// defaults; v1 is dropped once.
const STORAGE_KEY = 'shadowmitts.params.v2';
const OLD_KEYS = ['shadowmitts.params.v1'];

export function loadParams(): Params {
  try {
    for (const k of OLD_KEYS) localStorage.removeItem(k);
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? sanitizeParams(JSON.parse(raw)) : defaultParams();
  } catch {
    return defaultParams();
  }
}

/** Only the values the player changed, so untouched ones follow future defaults. */
export function changedParams(p: Params): Partial<Params> {
  const d = defaultParams();
  const out: Partial<Params> = {};
  for (const def of PARAM_DEFS) if (p[def.key] !== d[def.key]) out[def.key] = p[def.key];
  return out;
}

function saveParams(p: Params): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(changedParams(p)));
  } catch {
    // Storage unavailable (private mode etc.) — sliders still work for this session.
  }
}

/** Builds one slider per PARAM_DEFS entry. Mutates `params` in place and persists it. */
export function buildTuningPanel(root: HTMLElement, params: Params, onChange: () => void): void {
  root.textContent = '';
  const inputs = new Map<ParamKey, { input: HTMLInputElement; out: HTMLOutputElement }>();
  let group = '';
  for (const d of PARAM_DEFS) {
    if (d.group !== group) {
      group = d.group;
      const h = document.createElement('div');
      h.className = 'tune-group';
      h.textContent = group;
      root.appendChild(h);
    }
    const row = document.createElement('label');
    row.className = 'tune-row';
    const name = document.createElement('span');
    name.textContent = d.label;
    name.title = `${d.key} (기본 ${d.default}${'unit' in d ? ' ' + d.unit : ''}, placeholder)`;
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(d.min);
    input.max = String(d.max);
    input.step = String(d.step);
    input.value = String(params[d.key]);
    const out = document.createElement('output');
    const fmt = () => {
      out.textContent = `${params[d.key]}${'unit' in d ? ' ' + d.unit : ''}`;
      out.classList.toggle('changed', params[d.key] !== d.default);
    };
    fmt();
    input.addEventListener('input', () => {
      params[d.key] = Number(input.value);
      fmt();
      saveParams(params);
      onChange();
    });
    inputs.set(d.key, { input, out });
    row.append(name, input, out);
    root.appendChild(row);
  }

  const actions = document.createElement('div');
  actions.className = 'row';
  const reset = document.createElement('button');
  reset.textContent = '기본값으로';
  reset.addEventListener('click', () => {
    Object.assign(params, defaultParams());
    saveParams(params);
    buildTuningPanel(root, params, onChange);
    onChange();
  });
  const copy = document.createElement('button');
  copy.textContent = '현재 값 JSON 복사';
  copy.addEventListener('click', async () => {
    const text = JSON.stringify(params, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      copy.textContent = '복사됨';
    } catch {
      prompt('복사하세요', text);
    }
    setTimeout(() => (copy.textContent = '현재 값 JSON 복사'), 1500);
  });
  actions.append(reset, copy);
  root.appendChild(actions);
}
