/**
 * Tiny rendering helpers. No framework: the whole site is a handful of views
 * that each return a string of HTML and then wire up their own listeners.
 */

class Raw {
  constructor(s) { this.s = s; }
  toString() { return this.s; }
}

/** Mark a string as already-safe HTML so `html` will not escape it again. */
export const raw = (s) => new Raw(s);

export function esc(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function render(v) {
  if (v === null || v === undefined || v === false || v === true) return '';
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(render).join('');
  return esc(v);
}

/**
 * Tagged template that escapes every interpolated value.
 * Pass `raw(...)`, an array, or another `html` result to nest markup.
 */
export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1];
  return raw(out);
}

export function mount(node, content) {
  node.innerHTML = String(content);
  return node;
}

/* ------------------------------------------------------------------ helpers */

/** Strip a phone number down to something wa.me and tel: will accept. */
export function dialable(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/[^\d+]/g, '');
  if (digits.length < 7) return null;
  return digits;
}

/** wa.me wants digits only, with the country code and no leading +. */
export function waNumber(phone) {
  const d = dialable(phone);
  if (!d) return null;
  let n = d.replace(/\D/g, '');
  // A local South African number (0XX...) needs the 27 country code.
  if (n.startsWith('0')) n = '27' + n.slice(1);
  return n;
}

export function waLink(phone, message) {
  const n = waNumber(phone);
  if (!n) return null;
  const q = message ? `?text=${encodeURIComponent(message)}` : '';
  return `https://wa.me/${n}${q}`;
}

/** "Sat 18 Oct" */
export function shortDate(iso) {
  if (!iso) return '';
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-ZA', { weekday: 'short', day: 'numeric', month: 'short' });
}

/** "15 December 2026" */
export function longDate(iso) {
  if (!iso) return '';
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric' });
}

export function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many || one + 's'}`;
}

/** Signed number for a game difference column. */
export function signed(n) {
  return n > 0 ? `+${n}` : String(n);
}

export function stat(label, value, opts = {}) {
  const sub = opts.sub ? html`<small>${opts.sub}</small>` : '';
  const bar = opts.percent === undefined ? '' : html`
    <div class="progress"><span style="width:${Math.max(0, Math.min(100, opts.percent))}%"></span></div>`;
  return html`
    <div class="stat ${opts.tone === 'orange' ? 'stat--orange' : ''}">
      <span class="stat__k">${label}</span>
      <span class="stat__v">${value}${sub}</span>
      ${bar}
    </div>`;
}

export function empty(title, body) {
  return html`<div class="empty"><h3>${title}</h3><p>${body}</p></div>`;
}

export function notice(kind, title, body) {
  return html`
    <div class="notice notice--${kind}">
      <strong>${title}</strong>
      ${body ? html`<p>${body}</p>` : ''}
    </div>`;
}

/** Flash a short message into a container, replacing whatever was there. */
export function flash(node, kind, title, body) {
  if (!node) return;
  mount(node, notice(kind, title, body));
  node.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/** Read a form into a plain object, trimming strings. */
export function formData(form) {
  const out = {};
  for (const [k, v] of new FormData(form).entries()) {
    out[k] = typeof v === 'string' ? v.trim() : v;
  }
  return out;
}

/** Turn an unexpected failure into something a player can actually read. */
export function errorText(err) {
  const msg = err && err.message ? err.message : String(err);
  if (/Failed to fetch|NetworkError|load failed/i.test(msg)) {
    return 'Could not reach the league database. Check your connection and try again.';
  }
  return msg;
}
