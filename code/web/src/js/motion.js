// The calendar item's enlargement is the focal motion. Dialog state and focus
// never wait for a visual effect; unsupported/reduced-motion paths stay native.
const ARRIVE = { duration: 380, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' };
const DEPART = { duration: 160, easing: 'cubic-bezier(0.4, 0, 1, 1)' };
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

export function motionRect(source) {
  const rect = typeof source?.getBoundingClientRect === 'function' ? source.getBoundingClientRect() : source;
  if (!rect || ![rect.left, rect.top, rect.width, rect.height].every(Number.isFinite)
    || rect.width <= 0 || rect.height <= 0) return null;
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

export function createDialogMotion() {
  let origin = null;
  let trigger = null;
  let running = null;
  let ghost = null;
  const reduced = () => typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const clearGhost = () => { ghost?.remove(); ghost = null; };
  function cancel() {
    running?.cancel?.(); running = null; clearGhost();
  }
  function rememberOrigin(source) {
    if (source?.nodeType === 1 && (source === document.body || source === document.documentElement)) return;
    const rect = motionRect(source);
    if (!rect) return;
    origin = rect;
    trigger = source?.nodeType === 1 ? source : null;
  }
  function enter(card, source = origin) {
    cancel();
    if (typeof card?.animate !== 'function' || reduced()) return;
    const target = motionRect(card);
    if (!target) return;
    const from = motionRect(source);
    const dx = from ? clamp(from.left + from.width / 2 - target.left - target.width / 2, -160, 160) : 0;
    const dy = from ? clamp(from.top + from.height / 2 - target.top - target.height / 2, -120, 120) : 10;
    const scale = from ? clamp(from.width / target.width, 0.84, 0.94) : 0.96;
    card.classList.add('dialog-motion');
    let animation;
    try { animation = card.animate([
      { transform: `translate(${dx}px, ${dy}px) scale(${scale})`, opacity: 0.72, filter: 'blur(2px)' },
      { transform: 'translate(0px, 0px) scale(1)', opacity: 1, filter: 'blur(0px)' },
    ], ARRIVE); } catch { return; }
    running = animation;
    animation.finished?.then(() => { if (running === animation) running = null; }, () => {});
  }
  function exit(card) {
    cancel();
    if (typeof card?.animate !== 'function' || reduced()) return;
    const rect = motionRect(card);
    if (!rect) return;
    const clone = card.cloneNode(true);
    clone.classList.add('modal-motion-ghost', 'dialog-motion');
    clone.setAttribute('aria-hidden', 'true');
    clone.setAttribute('inert', '');
    clone.setAttribute('role', 'presentation');
    clone.removeAttribute('id');
    clone.removeAttribute('tabindex');
    clone.removeAttribute('aria-labelledby');
    for (const node of clone.querySelectorAll('[id], [name], [tabindex], [role], [autofocus], [for]')) {
      for (const attr of ['id', 'name', 'tabindex', 'role', 'autofocus', 'for']) node.removeAttribute(attr);
    }
    Object.assign(clone.style, { position: 'fixed', left: `${rect.left}px`, top: `${rect.top}px`,
      width: `${rect.width}px`, height: `${rect.height}px`, margin: '0', maxHeight: 'none',
      maxWidth: 'none', pointerEvents: 'none', zIndex: '10000' });
    document.body.append(clone);
    ghost = clone;
    let animation;
    try {
      animation = clone.animate([
        { transform: 'scale(1)', opacity: 1, filter: 'blur(0px)' },
        { transform: 'scale(0.96)', opacity: 0, filter: 'blur(2px)' },
      ], DEPART);
    } catch { clearGhost(); return; }
    running = animation;
    const finish = () => { clone.remove(); if (ghost === clone) ghost = null; if (running === animation) running = null; };
    // The animation owns cleanup; no timers keep dialog state or keyboard focus alive.
    if (animation.finished?.then) animation.finished.then(finish, finish);
    else { animation.onfinish = finish; animation.oncancel = finish; }
  }
  return { rememberOrigin, enter, exit, cancel, forgetOrigin() { origin = null; trigger = null; },
    get origin() { return origin; }, get trigger() { return trigger; } };
}
