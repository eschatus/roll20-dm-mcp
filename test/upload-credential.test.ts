// The no-gem route to roll20-upload-cache.json: a DevTools "Copy as cURL" paste. Chrome has shipped
// several shapes of this, so each is pinned.
import { describe, it, expect } from "vitest";
import { parseCurlCredential } from "../src/bridge/upload-credential.js";

const UA = "Mozilla/5.0 (Windows NT 10.0) Chrome/151.0";
const JAR = "rack.session=abc%3D; roll20tempauth=x=y; cf_clearance=zzz";
const want = { cookies: { "rack.session": "abc%3D", roll20tempauth: "x=y", cf_clearance: "zzz" }, userAgent: UA };

describe("parseCurlCredential", () => {
  it("reads the bash form with -b", () => {
    const paste = `curl 'https://app.roll20.net/editor/' \\\n  -H 'accept: text/html' \\\n  -b '${JAR}' \\\n  -H 'user-agent: ${UA}'`;
    expect(parseCurlCredential(paste)).toEqual(want);
  });

  it("reads the older form with a cookie header", () => {
    const paste = `curl 'https://app.roll20.net/editor/' -H 'Cookie: ${JAR}' -H 'User-Agent: ${UA}'`;
    expect(parseCurlCredential(paste)).toEqual(want);
  });

  it("reads the cmd form with caret escapes", () => {
    const paste = `curl ^"https://app.roll20.net/editor/^" ^\n  -b ^"${JAR.replace(/%/g, "^%")}^" ^\n  -H ^"user-agent: ${UA}^"`;
    expect(parseCurlCredential(paste)).toEqual(want);
  });

  it("refuses another host's request, so foreign cookies never land in the file", () => {
    const paste = `curl 'https://roll20-99926.firebaseio.com/x' -b '${JAR}' -H 'user-agent: ${UA}'`;
    expect(() => parseCurlCredential(paste)).toThrow(/isn't to app\.roll20\.net/);
  });

  it("names what's missing, and never quotes the paste", () => {
    const noUa = `curl 'https://app.roll20.net/editor/' -b '${JAR}'`;
    expect(() => parseCurlCredential(noUa)).toThrow(/no User-Agent/);
    const noSession = `curl 'https://app.roll20.net/editor/' -b 'other=1' -H 'user-agent: ${UA}'`;
    expect(() => parseCurlCredential(noSession)).toThrow(/no rack\.session/);
    expect(() => parseCurlCredential("hello")).toThrow(/isn't a copied cURL/);
    try { parseCurlCredential(noUa); } catch (e) { expect((e as Error).message).not.toContain("abc"); }
  });
});
