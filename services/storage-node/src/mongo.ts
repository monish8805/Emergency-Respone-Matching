import { MongoClient } from "mongodb";
import type { Entry } from "./app";

// MongoDB persistence for one storage node.
// One database for the whole system; one collection per shard ("shard_0", "shard_1", "shard_2").
// Each of the shard's three nodes keeps its own copy, told apart by the nodeId field.
export async function connectMongo(uri: string, dbName: string, nodeId: string, shard: number) {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10_000 });
  await client.connect();
  const col = client.db(dbName).collection<{ _id: string; nodeId: string; key: string; value: unknown; version: number }>(
    `shard_${shard}`,
  );
  await col.createIndex({ nodeId: 1 });

  const docs = await col.find({ nodeId }).toArray();
  const initial: Array<[string, Entry]> = docs.map((d) => [d.key, { value: d.value, version: d.version }]);

  const onWrite = async (key: string, entry: Entry) => {
    await col.updateOne(
      { _id: `${nodeId}|${key}` },
      { $set: { nodeId, key, value: entry.value, version: entry.version } },
      { upsert: true },
    );
  };

  return { initial, onWrite, close: () => client.close() };
}
