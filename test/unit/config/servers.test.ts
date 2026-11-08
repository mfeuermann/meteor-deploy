import { describe, expect, it } from 'vitest';
import { parseServerFilter, selectServers } from '../../../src/config/servers.js';
import { CometError } from '../../../src/core/errors.js';

describe('parseServerFilter', () => {
  it('splits on commas and whitespace', () => {
    expect(parseServerFilter('one,two three')).toEqual(['one', 'two', 'three']);
    expect(parseServerFilter(' one ,  two ')).toEqual(['one', 'two']);
  });

  it('returns null for empty or missing input', () => {
    expect(parseServerFilter('')).toBeNull();
    expect(parseServerFilter('  ')).toBeNull();
    expect(parseServerFilter(undefined)).toBeNull();
  });
});

describe('selectServers', () => {
  it('returns all servers without a filter', () => {
    expect(selectServers(['one', 'two'], null)).toEqual(['one', 'two']);
  });

  it('keeps config order', () => {
    expect(selectServers(['one', 'two', 'three'], ['three', 'one'])).toEqual(['one', 'three']);
  });

  it('throws a CometError naming an unknown server', () => {
    expect(() => selectServers(['one', 'two'], ['three'])).toThrow(CometError);
    expect(() => selectServers(['one', 'two'], ['three'])).toThrow(/three/);
  });
});
