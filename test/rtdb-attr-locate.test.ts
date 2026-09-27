import { describe, it, expect } from "vitest";
import { candidatePaths, findValuePaths, templatize, childCount } from "../src/recon/rtdb-attr-locate-lib.js";

// Pure helpers behind src/recon/rtdb-attr-locate.ts (#230 / #225). The live question — which RTDB
// node holds attributes — is answered by running the script; these pin the search and reporting.
const CID = "-NcharAbcdefghijklmn"; // 20 chars, push-id shaped
const AID = "-NattrAbcdefghijklmn";

describe("rtdb attribute locator helpers", () => {
  it("lists the Roll20-client shape first and still checks char-blobs", () => {
    const c = candidatePaths(CID);
    expect(c[0]).toBe(`char-attribs/char/${CID}`);
    expect(c).toContain(`char-blobs/${CID}`);
    expect(new Set(c).size).toBe(c.length);
  });

  it("finds every leaf containing the marker, with the enclosing attribute record", () => {
    const tree = {
      [AID]: { name: "attrprobe_pair", current: "M1-cur", max: "M1-max" },
      other: { name: "hp", current: "12" },
      deep: { a: { b: "prefix M1-plain suffix" } },
    };
    const hits = findValuePaths(tree, "M1");
    expect(hits.map((h) => h.path).sort()).toEqual([`${AID}/current`, `${AID}/max`, "deep/a/b"].sort());
    const cur = hits.find((h) => h.path.endsWith("current"))!;
    expect(cur.value).toBe("M1-cur");
    expect(cur.record).toMatchObject({ name: "attrprobe_pair" });
    expect(hits.find((h) => h.path === "deep/a/b")!.record).toBeUndefined();
  });

  it("ignores non-string leaves and respects the depth bound", () => {
    expect(findValuePaths({ n: 5, b: true, z: null }, "5")).toEqual([]);
    let deep: unknown = "M2";
    for (let i = 0; i < 12; i++) deep = { x: deep };
    expect(findValuePaths(deep, "M2", 8)).toEqual([]);
    expect(findValuePaths(deep, "M2", 20)).toHaveLength(1);
  });

  it("templatizes the character id and push ids but keeps structural segments", () => {
    expect(templatize(`char-attribs/char/${CID}/${AID}/current`, CID))
      .toBe("char-attribs/char/<charId>/<pushId>/current");
    expect(templatize(`characters/${CID}/name`, CID)).toBe("characters/<charId>/name");
  });

  it("counts shallow children", () => {
    expect(childCount({ a: true, b: true })).toBe(2);
    expect(childCount(null)).toBeNull();
  });
});
