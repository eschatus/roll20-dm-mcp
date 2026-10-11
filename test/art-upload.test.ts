import { describe, it, expect } from "vitest";
import sharp from "sharp";
import {
  planVariants, prepareUpload, uploadPrepared, UploadAuthError, UploadStageError,
  WEBP_MAX_PIXELS, type PreparedUpload,
} from "../src/bridge/art-upload.js";

// Roll20's Art Library upload (#243). The variant rules come from Roll20's own client
// (`variantSizeArray`, `webpMaxPixels`, `webpQualityLevel` in the Jumpgate vtt.bundle) and are
// pinned here against the two uploads captured live on 2026-10-11.

const png = (w: number, h: number) =>
  sharp({ create: { width: w, height: h, channels: 3, background: { r: 120, g: 40, b: 200 } } }).png().toBuffer();
const dims = async (b: Buffer) => { const m = await sharp(b).metadata(); return `${m.width}x${m.height} ${m.format}`; };

describe("planVariants — Roll20's longest-side caps 200/512/2048/10000, never upscaled", () => {
  it("matches the live 4096×1963 map upload exactly", () => {
    expect(planVariants(4096, 1963).map((v) => `${v.variantName} ${v.width}x${v.height}`)).toEqual([
      "thumb 200x96", "med 512x245", "max 2048x982", "original 4096x1963",
    ]);
  });
  it("matches the live 400×400 token upload (med/max/original stay full size)", () => {
    expect(planVariants(400, 400).map((v) => `${v.width}x${v.height}`)).toEqual(["200x200", "400x400", "400x400", "400x400"]);
  });
  it("caps the original at 10000 on the longest side, portrait or landscape", () => {
    expect(planVariants(12000, 3000).at(-1)).toMatchObject({ width: 10000, height: 2500 });
    expect(planVariants(3000, 12000).at(-1)).toMatchObject({ width: 2500, height: 10000 });
  });
  it("refuses an image with no dimensions", () => {
    expect(() => planVariants(0, 100)).toThrow(/no usable dimensions/);
  });
});

describe("prepareUpload — the four variants, encoded the way Roll20's client does", () => {
  it("converts a PNG to webp, reports the SOURCE size, and reuses one full-size blob", async () => {
    const src = await png(400, 400);
    const p = await prepareUpload("/maps/eyedrake.png", src);
    expect(p).toMatchObject({ name: "eyedrake.webp", type: "image/webp", size: src.length });
    expect(p.variants.map((v) => v.name)).toEqual(["thumb.webp", "med.webp", "max.webp", "original.webp"]);
    expect(await dims(p.variants[0].bytes)).toBe("200x200 webp");
    expect(await dims(p.variants[3].bytes)).toBe("400x400 webp");
    // med/max/original are the same blob, as in the live capture (all three 34,996 bytes)
    expect(p.variants[1].bytes).toBe(p.variants[3].bytes);
    expect(p.variants[2].bytes).toBe(p.variants[3].bytes);
  });

  it("resizes a big map into all four sizes", async () => {
    const p = await prepareUpload("/maps/big map.png", await png(4096, 1963));
    expect(await Promise.all(p.variants.map((v) => dims(v.bytes)))).toEqual([
      "200x96 webp", "512x245 webp", "2048x982 webp", "4096x1963 webp",
    ]);
    expect(p.name).toBe("big map.webp");
  });

  it("passes a webp source through untouched at full size", async () => {
    const src = await sharp(await png(300, 200)).webp({ quality: 50 }).toBuffer();
    const p = await prepareUpload("/a/token.webp", src);
    expect(p.variants[3].bytes).toBe(src);
  });

  it("keeps the source type above 16 MP, as Roll20 does", async () => {
    const w = 5000, h = Math.ceil(WEBP_MAX_PIXELS / 5000) + 10; // just over the limit
    const p = await prepareUpload("/maps/huge.png", await png(w, h));
    expect(p.type).toBe("image/png");
    expect(p.name).toBe("huge.png");
    expect(p.variants.map((v) => v.name)).toEqual(["thumb.png", "med.png", "max.png", "original.png"]);
    expect(await dims(p.variants[0].bytes)).toMatch(/^200x\d+ png$/);
  });

  it("refuses unsupported and animated images instead of half-uploading them", async () => {
    await expect(prepareUpload("/a/clip.gif", Buffer.from("GIF89a"))).rejects.toThrow(/unsupported image type/);
    // A real two-frame animated webp (8×8, made with Pillow). sharp's own `join: { animated }`
    // silently flattens to one frame in this version, so it can't build the fixture.
    const animated = Buffer.from(
      "UklGRsQAAABXRUJQVlA4WAoAAAACAAAABwAABwAAQU5JTQYAAAAAAAAAAABBTk1GSgAAAAAAAAAAAAcAAAcAAGQAAAJWUDggMgAAADABAJ0BKggACAABQCYloAADcAD+8ut///mwP/bz/wR6Af//0uD//pcH//S4P/SkAAAAQU5NRkYAAAAAAAAAAAAHAAAHAABkAAAAVlA4IC4AAAA0AQCdASoIAAgAAAAmJaAAA3AA/vtV4///S4P/+lwf/9Lg/9Lg//rV5Vesq6AA",
      "base64",
    );
    expect((await sharp(animated).metadata()).pages).toBe(2);
    await expect(prepareUpload("/a/anim.webp", animated)).rejects.toThrow(/animated/);
  });
});

// ── the three-step HTTP flow, against a recorded fake ────────────────────────────────────────
type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };
function fakeRoll20(over: Partial<Record<"reqimage" | "sign" | "put", (c: Call) => Response>> = {}) {
  const calls: Call[] = [];
  const signed = Object.fromEntries(["thumb", "med", "max", "original"].map((v) => [v, {
    final: `https://files.d20.io/images/503899952/KEY/${v}.webp`,
    base: `https://files.d20.io/files-d20-io/images/503899952/KEY/${v}.webp`,
    additional: `?X-Amz-Signature=sig-${v}`,
  }]));
  const doFetch = (async (url: string, init: RequestInit) => {
    const c: Call = { url, method: String(init.method), headers: init.headers as Record<string, string>, body: init.body };
    calls.push(c);
    if (url.endsWith("/image_library/reqimage")) return over.reqimage?.(c) ?? new Response("542706052");
    if (url.includes("/image_library/s3putsign_batch/")) return over.sign?.(c) ?? new Response(JSON.stringify(signed));
    if (init.method === "PUT") return over.put?.(c) ?? new Response(null, { status: 200 });
    throw new Error(`unexpected ${url}`);
  }) as unknown as typeof fetch;
  return { calls, doFetch };
}
const CRED = { cookies: { "rack.session": "s3cret", roll20tempauth: "t0ken" }, userAgent: "UA/1.0" };
const prepared = async (): Promise<PreparedUpload> => prepareUpload("/maps/m.png", await png(1000, 500));

describe("uploadPrepared — reqimage → s3putsign_batch → four presigned PUTs", () => {
  it("makes Roll20's calls in order and returns the original variant's CDN URL", async () => {
    const p = await prepared();
    const { calls, doFetch } = fakeRoll20();
    const url = await uploadPrepared(p, CRED, doFetch);
    expect(url).toBe("https://files.d20.io/images/503899952/KEY/original.webp");
    expect(calls.map((c) => `${c.method} ${c.url.replace(/\?.*/, "")}`)).toEqual([
      "POST https://app.roll20.net/image_library/reqimage",
      "POST https://app.roll20.net/image_library/s3putsign_batch/542706052",
      "PUT https://files.d20.io/files-d20-io/images/503899952/KEY/thumb.webp",
      "PUT https://files.d20.io/files-d20-io/images/503899952/KEY/med.webp",
      "PUT https://files.d20.io/files-d20-io/images/503899952/KEY/max.webp",
      "PUT https://files.d20.io/files-d20-io/images/503899952/KEY/original.webp",
    ]);
    // reqimage: the normalised name/type and the SOURCE byte size, form-encoded, with cookies + UA
    expect(Object.fromEntries(new URLSearchParams(String(calls[0].body)))).toEqual({ name: "m.webp", type: "image/webp", size: String(p.size) });
    expect(calls[0].headers.Cookie).toBe("rack.session=s3cret; roll20tempauth=t0ken");
    expect(calls[0].headers["User-Agent"]).toBe("UA/1.0");
    // s3putsign_batch: each variant's REAL encoded size
    expect(JSON.parse(String(calls[1].body))).toEqual(p.variants.map((v) => ({ variantName: v.variantName, name: v.name, size: v.bytes.length, type: "image/webp" })));
    // PUTs: the signed URL, the bytes, and NO cookies
    expect(calls[2].url).toBe("https://files.d20.io/files-d20-io/images/503899952/KEY/thumb.webp?X-Amz-Signature=sig-thumb");
    for (const put of calls.slice(2)) {
      expect(put.headers).toEqual({ "Content-Type": "image/webp" });
      expect((put.body as Uint8Array).length).toBeGreaterThan(0);
    }
  });

  it("reports a refused credential as an auth error (Cloudflare page or 403), never as a stage error", async () => {
    const p = await prepared();
    for (const reqimage of [() => new Response("Forbidden", { status: 403 }), () => new Response("<html><title>Just a moment...</title>", { status: 503 })]) {
      const { doFetch } = fakeRoll20({ reqimage });
      await expect(uploadPrepared(p, CRED, doFetch)).rejects.toBeInstanceOf(UploadAuthError);
    }
  });

  it("names the failing step and the orphaned upload id", async () => {
    const p = await prepared();
    const bad = fakeRoll20({ reqimage: () => new Response("not-an-id") });
    await expect(uploadPrepared(p, CRED, bad.doFetch)).rejects.toThrow(/reqimage: expected a numeric upload id/);
    const putFail = fakeRoll20({ put: (c) => new Response(null, { status: c.url.includes("/max.webp") ? 500 : 200 }) });
    const err = await uploadPrepared(p, CRED, putFail.doFetch).catch((e) => e);
    expect(err).toBeInstanceOf(UploadStageError);
    expect(err.message).toMatch(/put:max: HTTP 500.*upload id 542706052/);
    const noSig = fakeRoll20({ sign: () => new Response(JSON.stringify({ thumb: {} })) });
    await expect(uploadPrepared(p, CRED, noSig.doFetch)).rejects.toThrow(/sign:thumb: no presigned URL/);
  });
});
