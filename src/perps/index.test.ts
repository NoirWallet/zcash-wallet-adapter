import { describe, expect, it } from 'vitest';

import { PerpsClient } from './index.js';

describe('RHEA Perps SDK export', () => {
  it('exports PerpsClient from the isolated perps entry', () => {
    expect(typeof PerpsClient).toBe('function');
  });
});
