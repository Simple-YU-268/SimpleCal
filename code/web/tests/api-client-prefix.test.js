/**
 * 0.1.6 统一网关：API base 必须跟随 `/app/SimpleCal` 前缀。
 * 直连端口 / 本地测试（pathname `/`）保持旧行为。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

afterEach(() => {
  window.history.replaceState(null, '', '/');
});

describe('api-client — 网关前缀', () => {
  it('页面在 /app/SimpleCal/ 时 API base 带前缀', async () => {
    window.history.replaceState(null, '', '/app/SimpleCal/');
    vi.resetModules();
    const mod = await import('../src/js/api-client.js');
    expect(mod.APP_BASE).toBe('/app/SimpleCal');
    expect(mod.BASE).toBe('/app/SimpleCal/api/v1');
  });

  it('直连根路径时保持 /api/v1（旧行为）', async () => {
    window.history.replaceState(null, '', '/');
    vi.resetModules();
    const mod = await import('../src/js/api-client.js');
    expect(mod.APP_BASE).toBe('');
    expect(mod.BASE).toBe('/api/v1');
  });
});
