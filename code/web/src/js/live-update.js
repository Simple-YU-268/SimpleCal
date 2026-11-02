import { el } from './dom.js';

export function hasOpenEditor(root = document) {
  return [...root.querySelectorAll('[role="dialog"], [role="alertdialog"]')]
    .some((node) => !node.hidden && node.getAttribute('aria-hidden') !== 'true');
}

export function watchForUpdates(registration, activate = () => registration.waiting?.postMessage({ type: 'SKIP_WAITING' })) {
  let banner = null;
  let requested = false;
  let reloaded = false;
  let externallyActivated = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!requested) {
      externallyActivated = true;
      if (banner) {
        banner.querySelector('span').textContent = '其他页面已更新，请保存当前内容后刷新';
        const button = banner.querySelector('button');
        button.disabled = false;
        button.textContent = '刷新页面';
      }
      return;
    }
    if (reloaded) return;
    reloaded = true;
    window.location.reload();
  });
  function offer() {
    if (!registration.waiting || banner) return;
    const message = el('span', { text: '新版本已就绪' });
    const button = el('button', { class: 'btn btn--primary', type: 'button', text: '更新并刷新' });
    banner = el('div', { class: 'update-notice', role: 'status', 'aria-live': 'polite' }, [message, button]);
    button.addEventListener('click', () => {
      if (hasOpenEditor()) {
        message.textContent = '请先保存或关闭当前窗口，再更新';
        return;
      }
      if (externallyActivated) { window.location.reload(); return; }
      if (!registration.waiting) { banner.remove(); banner = null; return; }
      requested = true;
      button.disabled = true;
      button.textContent = '正在更新';
      activate();
    });
    document.body.append(banner);
  }
  offer();
  registration.addEventListener('updatefound', () => {
    const worker = registration.installing;
    worker?.addEventListener('statechange', () => {
      if (worker.state === 'installed' && navigator.serviceWorker.controller) offer();
    });
  });
  const check = () => {
    if (document.visibilityState === 'visible' && navigator.onLine !== false) registration.update().catch(() => {});
  };
  window.setInterval(check, 5 * 60 * 1000);
  document.addEventListener('visibilitychange', check);
  window.addEventListener('online', check);
  check();
}
