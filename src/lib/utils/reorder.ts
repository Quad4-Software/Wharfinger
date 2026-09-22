// Move an item from one index to another, returning a new list.
// Out-of-range or no-op moves return the input unchanged.
export function reorder<T>(list: T[], from: number, to: number): T[] {
	if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) {
		return list;
	}
	const next = [...list];
	const [item] = next.splice(from, 1);
	next.splice(to, 0, item);
	return next;
}
