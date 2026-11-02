import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('touch switch geometry', () => {
  const css = readFileSync(path.resolve('src/styles/base.css'), 'utf8');
  it('keeps the track fixed while the touch target grows', () => {
    const track = css.match(/\.switch__track\s*\{([^}]+)\}/)[1];
    expect(track).toContain('height: 24px');
    expect(track).toContain('top: 50%');
    expect(track).toContain('translateY(-50%)');
    expect(track).not.toMatch(/inset:\s*0\s*;/);
  });
  it('centers the thumb independently of the touch target height', () => {
    const thumb = css.match(/\.switch__thumb\s*\{([^}]+)\}/)[1];
    expect(thumb).toContain('top: calc(50% - 9px)');
    expect(thumb).toContain('height: 18px');
  });
});
