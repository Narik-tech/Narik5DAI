/** Per-analysis LRU of neural values. Never stores depth-dependent mate scores. */
export function createValueCache(keyPosition, { maxEntries = 4096, maxBytes = 32 * 1024 * 1024 } = {}) {
  const objects = new WeakMap(), entries = new Map();
  let bytes = 0, hits = 0;
  // The rules key uses action parity; the model also sees the absolute action.
  const keyFor = position => position.action + ':' + keyPosition(position);
  return {
    get(position) {
      if (objects.has(position)) return objects.get(position);
      if (!maxEntries || !maxBytes) return undefined;
      const key = keyFor(position), entry = entries.get(key);
      if (!entry) return undefined;
      entries.delete(key); entries.set(key, entry);
      objects.set(position, entry.value); hits++;
      return entry.value;
    },
    has(position) { return this.get(position) !== undefined; },
    set(position, value) {
      if (!Number.isFinite(value)) throw new Error('Cannot cache a nonfinite neural value.');
      objects.set(position, value);
      if (!maxEntries || !maxBytes) return;
      const key = keyFor(position), size = key.length * 2 + 64;
      const previous = entries.get(key);
      if (previous) { bytes -= previous.size; entries.delete(key); }
      if (size > maxBytes) return;
      while (entries.size >= maxEntries || bytes + size > maxBytes) {
        const oldest = entries.keys().next().value;
        bytes -= entries.get(oldest).size; entries.delete(oldest);
      }
      entries.set(key, { value, size }); bytes += size;
    },
    get size() { return entries.size; },
    get bytes() { return bytes; },
    get hits() { return hits; },
  };
}
