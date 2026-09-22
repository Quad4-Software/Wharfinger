import { describe, expect, it } from 'vitest';
import { reorder } from '$lib/utils/reorder';

describe('reorder', () => {
	it('moves an item forward and backward', () => {
		expect(reorder(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd']);
		expect(reorder(['a', 'b', 'c', 'd'], 3, 0)).toEqual(['d', 'a', 'b', 'c']);
		expect(reorder(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'b', 'c']);
	});

	it('does not mutate the input and rejects out-of-range indexes', () => {
		const list = [{ id: 'x' }, { id: 'y' }];
		expect(reorder(list, -1, 0)).toBe(list);
		expect(reorder(list, 0, 2)).toBe(list);
		expect(reorder(list, 5, 0)).toBe(list);
		const moved = reorder(list, 0, 1);
		expect(moved.map((i) => i.id)).toEqual(['y', 'x']);
		expect(list.map((i) => i.id)).toEqual(['x', 'y']);
	});
});
