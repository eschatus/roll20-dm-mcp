import { rtGet, rtUpdate } from "./roll20-rt.js";

// A character's default token, written where Roll20 actually keeps it.
//
// The Mod's ch.set("defaulttoken", ...) reports success and leaves the blob empty (#277). A sheet
// made in the UI has the JSON at char-blobs/<id>/defaulttoken and a timestamp at
// characters/<id>/defaulttoken, so those two nodes are what gets written here, and the blob is read
// back because the Mod's own report was how this went unnoticed.

export class DefaultTokenWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DefaultTokenWriteError";
  }
}

export type DefaultTokenStore = {
  write(charId: string, blob: string, stamp: number): Promise<void>;
  read(charId: string): Promise<unknown>;
};

const rtdbStore: DefaultTokenStore = {
  async write(charId, blob, stamp) {
    await rtUpdate(`char-blobs/${charId}`, { defaulttoken: blob });
    await rtUpdate(`characters/${charId}`, { defaulttoken: stamp });
  },
  read: (charId) => rtGet(`char-blobs/${charId}/defaulttoken`),
};

// Test seam, the analogue of attributes.ts's __setAttributeTestSource.
let _testStore: DefaultTokenStore | null = null;
export function __setDefaultTokenTestStore(store: DefaultTokenStore | null): void {
  _testStore = store;
}

/** Store a default token's JSON on a character, and confirm the blob holds it. */
export async function writeDefaultTokenRt(charId: string, blob: string): Promise<void> {
  const store = _testStore ?? rtdbStore;
  await store.write(charId, blob, Date.now());
  const held = await store.read(charId);
  if (held !== blob) {
    throw new DefaultTokenWriteError(`The default token did not land on character ${charId}: its blob holds ${JSON.stringify(held)?.slice(0, 80)}.`);
  }
}
