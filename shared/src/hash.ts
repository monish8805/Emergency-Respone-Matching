// djb2 string hash, kept unsigned 32-bit.
export function hashKey(key: string): number {
  let h = 5381;
  for (let i = 0; i < key.length; i++) {
    h = ((h << 5) + h + key.charCodeAt(i)) >>> 0;
  }
  return h;
}

// Routes a key to a shard: hash(key) mod shardCount.
export function shardFor(key: string, shardCount: number): number {
  return hashKey(key) % shardCount;
}
