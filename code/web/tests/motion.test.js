import { describe, it, expect, vi, afterEach } from 'vitest';
import { createDialogMotion, motionRect } from '../src/js/motion.js';
import { createEventModal } from '../src/js/modal.js';
import { DEFAULT_SETTINGS } from '../src/js/store.js';
import { t } from '../src/i18n/index.js';

const rect = (left = 500, top = 200, width = 440, height = 360) => ({ left, top, width, height });
let originalAnimate = Element.prototype.animate;
let originalMedia = window.matchMedia;
afterEach(() => {
  Element.prototype.animate = originalAnimate;
  window.matchMedia = originalMedia;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});
function card() {
  const node = document.createElement('form');
  node.className = 'modal'; node.id = 'dialog';
  node.innerHTML = '<label for="title">Task</label><input id="title" name="task"><button role="button" tabindex="0">Save</button>';
  node.getBoundingClientRect = () => rect();
  document.body.append(node);
  return node;
}
function animationStub() {
  let finish;
  const finished = new Promise((resolve) => { finish = resolve; });
  return { finished, finish, cancel: vi.fn() };
}
describe('task-detail continuity', () => {
  it('keeps the original task trigger through details-to-editor and animates a DOM close event', () => {
    const animation = animationStub();
    Element.prototype.animate = vi.fn(() => animation);
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(rect());
    const trigger = document.createElement('button');
    trigger.textContent = 'Task';
    document.body.append(trigger);
    trigger.focus();
    const modal = createEventModal({ store: {
      getSettings: () => ({ ...DEFAULT_SETTINGS }), getEvent: () => null, getTask: () => null,
      saveEvent: async (event) => event, saveTask: async (task) => task,
    } });
    modal.openView({ id: 'task-1', title: 'Review', isTask: true, due: new Date(2026, 10, 2).getTime(), allDay: true, reminders: [] }, trigger);
    expect(document.querySelector('.modal--view')).not.toBeNull();
    const edit = document.querySelector(`[aria-label="${t('editor.editKind', { kind: t('editor.mode.task') })}"]`);
    expect(edit).not.toBeNull();
    edit.click();
    expect(document.querySelector('.modal--view')).toBeNull();
    expect(document.querySelector('.input--title').value).toBe('Review');
    modal.close(new MouseEvent('click'));
    expect(modal.isOpen()).toBe(false);
    expect(document.activeElement).toBe(trigger);
    expect(document.querySelector('.modal-motion-ghost')).not.toBeNull();
    modal.close(true);
    expect(document.querySelector('.modal-motion-ghost')).toBeNull();
  });
  it('opens an undated task without inventing a deadline or throwing on invalid dates', () => {
    const modal = createEventModal({ store: { getSettings: () => ({ ...DEFAULT_SETTINGS }) } });
    for (const due of [undefined, null, 'invalid']) {
      expect(() => modal.openView({ id: 'undated', title: 'Someday', isTask: true, due })).not.toThrow();
      const detail = document.querySelector('.modal--view');
      expect(detail.textContent).toContain('Someday');
      expect(detail.textContent).not.toContain('Invalid Date');
      modal.close(true);
    }
  });
  it('uses the source rectangle to enlarge smoothly while the dialog stays immediately usable', () => {
    const animation = animationStub();
    Element.prototype.animate = vi.fn(() => animation);
    const motion = createDialogMotion(), node = card();
    motion.rememberOrigin(rect(1000, 300, 240, 44));
    motion.enter(node);
    const [frames, timing] = Element.prototype.animate.mock.calls[0];
    expect(frames[0].transform).toContain('scale(0.84)');
    expect(frames[0].transform).not.toContain('translate(0px, 0px)');
    expect(frames.at(-1).transform).toBe('translate(0px, 0px) scale(1)');
    expect(timing.duration).toBeLessThanOrEqual(400);
    expect(node.isConnected).toBe(true);
    expect(node.hasAttribute('inert')).toBe(false);
    motion.cancel();
  });
  it('respects reduced motion and works without the Web Animations API', () => {
    Element.prototype.animate = vi.fn();
    window.matchMedia = () => ({ matches: true });
    const motion = createDialogMotion(), node = card();
    motion.enter(node); motion.exit(node);
    expect(Element.prototype.animate).not.toHaveBeenCalled();
    expect(document.querySelector('.modal-motion-ghost')).toBeNull();
    Element.prototype.animate = undefined;
    window.matchMedia = () => ({ matches: false });
    expect(() => motion.enter(node)).not.toThrow();
    expect(() => motion.exit(node)).not.toThrow();
  });
  it('removes live state immediately and exits only through an inert, identifier-free visual copy', async () => {
    const animation = animationStub();
    Element.prototype.animate = vi.fn(() => animation);
    const motion = createDialogMotion(), node = card();
    motion.exit(node); node.remove();
    const ghost = document.querySelector('.modal-motion-ghost');
    expect(ghost).not.toBeNull();
    expect(ghost.getAttribute('aria-hidden')).toBe('true');
    expect(ghost.hasAttribute('inert')).toBe(true);
    expect(ghost.querySelector('[id], [name], [role], [tabindex], [for]')).toBeNull();
    expect(document.querySelector('#dialog')).toBeNull();
    animation.finish(); await animation.finished;
    expect(document.querySelector('.modal-motion-ghost')).toBeNull();
  });
  it('a new open cancels an interrupted exit and invalid rectangles do not create spatial motion', () => {
    const animation = animationStub();
    Element.prototype.animate = vi.fn(() => animation);
    const motion = createDialogMotion(), node = card();
    motion.exit(node);
    motion.enter(node, rect(0, 0, 100, 20));
    expect(animation.cancel).toHaveBeenCalled();
    expect(document.querySelector('.modal-motion-ghost')).toBeNull();
    expect(motionRect({ left: 0, top: NaN, width: 10, height: 10 })).toBeNull();
    expect(motionRect({ left: 0, top: 0, width: 0, height: 10 })).toBeNull();
    motion.cancel();
  });
});
