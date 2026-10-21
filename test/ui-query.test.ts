import { expect, it } from 'vitest';
import { maxPredicates, predicates, sortProblem } from '../app/src/lib/query';

const definition = { slug: 'c', version: 1, unique: [], filterable: ['n', 't', 's', 'built', 'pending'], sortable: ['n', 'hidden', 'pending'],
  schema: { type: 'object', properties: { n: { type: 'number' }, t: { type: 'string', format: 'date-time' }, s: { type: 'string' },
    built: { type: 'string' }, pending: { type: 'string' }, hidden: { type: 'string' } } } };
// "pending" is declared filterable and sortable, but its index is still being built.
const ready = ['n', 't', 's', 'built', 'hidden'];
const check = (field: string, op: string, value: string) => predicates(definition as never, [{ field, op, value }], ready);

it('a filter value is sent only when it is JSON number syntax or a real calendar instant', () => {
  for (const value of ['0x10', '0b11', '1_000', '.5', '+1', 'Infinity', '1e400']) expect(check('n', 'eq', value).errors).toHaveProperty('0');
  expect(check('n', 'in', '-1.5e3, 0').predicates).toEqual([{ field: 'n', kind: 'number', operator: 'in', value: [-1500, 0] }]);
  for (const value of ['2026-02-30T12:00:00Z', '2026-01-31T24:00:00Z', '2026-01-31T12:60:00Z', '0000-01-01T00:00:00Z', '2026-13-01T00:00:00Z'])
    expect(check('t', 'eq', value).errors).toHaveProperty('0');
  expect(check('t', 'in', '2026-01-31T12:00:00Z, 2026-02-29T00:00:00Z').errors).toHaveProperty('0');
  for (const value of ['2024-02-29T23:59:59.5Z', '2016-12-31T23:59:60Z', '1972-06-30T23:59:60.25Z'])
    expect(check('t', 'gte', value).predicates).toEqual([{ field: 't', kind: 'date-time', operator: 'gte', value }]);
});

it('a leap second is accepted only on a day IERS announced one, as the authority accepts it', () => {
  // 2016-12-31 had a leap second; 2016-06-30 and 2026-01-31 did not, and 23:58:60 never exists.
  for (const value of ['2026-01-31T23:59:60Z', '2016-06-30T23:59:60Z', '2016-12-31T23:58:60Z'])
    expect(check('t', 'eq', value).errors[0]).toMatch(/UTC instant/);
});

it('a text value is limited to 512 UTF-8 bytes, counted in bytes rather than characters', () => {
  for (const value of ['a'.repeat(512), 'é'.repeat(256), '😀'.repeat(128)]) expect(check('s', 'eq', value).predicates).toHaveLength(1);
  for (const value of ['a'.repeat(513), `${'é'.repeat(256)}a`, `${'😀'.repeat(128)}a`])
    expect(check('s', 'eq', value).errors[0]).toMatch(/512 bytes/);
  expect(check('s', 'in', `ok,${'é'.repeat(257)}`).errors[0]).toMatch(/512 bytes/);
  // A date-time is ASCII, so a long fraction is measured the same way.
  expect(check('t', 'eq', `2026-01-31T12:00:00.${'1'.repeat(491)}Z`).predicates).toHaveLength(1);
  expect(check('t', 'eq', `2026-01-31T12:00:00.${'1'.repeat(492)}Z`).errors).toHaveProperty('0');
});

it('at most 16 filters are sent; each one past that is reported on its own row', () => {
  const rows = Array.from({ length: maxPredicates + 1 }, (_, index) => ({ field: 's', op: 'eq', value: String(index) }));
  expect(maxPredicates).toBe(16);
  expect(predicates(definition as never, rows.slice(0, maxPredicates), ready).errors).toEqual({});
  const over = predicates(definition as never, rows, ready);
  expect(Object.keys(over.errors)).toEqual([String(maxPredicates)]);
  expect(over.errors[maxPredicates]).toMatch(/At most 16 filters/);
});

it('a filter or sort the authority would refuse is reported on its field before any request', () => {
  expect(check('nope', 'eq', 'x').errors[0]).toBe('Choose a declared field.');
  expect(check('hidden', 'eq', 'x').errors[0]).toMatch(/not filterable/);
  expect(check('pending', 'eq', 'x').errors[0]).toMatch(/still being built/);
  expect(check('pending', 'isNull', '').errors[0]).toMatch(/still being built/);
  expect(check('built', 'eq', 'x').predicates).toEqual([{ field: 'built', kind: 'string', operator: 'eq', value: 'x' }]);
  expect(sortProblem(definition as never, ready, 'nope')).toBe('Choose a declared field.');
  expect(sortProblem(definition as never, ready, 's')).toMatch(/not sortable/);
  expect(sortProblem(definition as never, ready, 'pending')).toMatch(/still being built/);
  for (const field of ['n', 'hidden']) expect(sortProblem(definition as never, ready, field)).toBeNull();
});
