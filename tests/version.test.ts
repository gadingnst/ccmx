import { expect, it } from 'bun:test';
import { VERSION } from '@/version';
import pkg from '../package.json';

it('matches package.json', () => {
  expect(VERSION).toBe(pkg.version);
});
