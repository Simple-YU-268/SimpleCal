import { it, expect, afterEach } from 'vitest';
import { hasOpenEditor } from '../src/js/live-update.js';

afterEach(() => { document.body.innerHTML = ''; });
it('blocks refresh while a dialog is open', () => {
  document.body.innerHTML = '<div role="dialog"></div>';
  expect(hasOpenEditor()).toBe(true);
});
it('ignores hidden dialogs', () => {
  document.body.innerHTML = '<div role="dialog" hidden></div><div role="dialog" aria-hidden="true"></div>';
  expect(hasOpenEditor()).toBe(false);
});
