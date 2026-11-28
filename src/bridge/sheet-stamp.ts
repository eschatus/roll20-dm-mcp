import { rtGet, rtUpdate } from "./roll20-rt.js";

// A character's `charactersheetname`, written where Roll20 keeps it.
//
// A character made in the UI has this property and one made through the Mod does not. The Mod's own
// write drops it without an error (#277), so it goes to RTDB here and is read back.

export class SheetStampError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SheetStampError";
  }
}

export async function stampSheetName(charId: string, sheetName: string): Promise<void> {
  const path = `characters/${charId}`;
  await rtUpdate(path, { charactersheetname: sheetName });
  const held = await rtGet(`${path}/charactersheetname`);
  if (held !== sheetName) {
    throw new SheetStampError(`Character ${charId} was created, but its sheet name did not land: it holds ${JSON.stringify(held)}, not "${sheetName}".`);
  }
}
