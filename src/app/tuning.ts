import { PARAM_DEFS, defaultParams, sanitizeParams, type ParamKey, type Params } from '../core/params';

const STORAGE_KEY = 'shadowmitts.params.v1';

export function loadParams(): Params {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? sanitizeParams(JSON.parse(raw)) : defaultParams();
  } catch {
    return defaultParams();
  }
}

function saveParams(p: Params): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
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
