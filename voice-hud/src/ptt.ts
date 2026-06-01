// Global push-to-talk via uiohook-napi. Electron's globalShortcut can't reliably
// do hold-to-talk (no keyup, no mouse buttons), so we use a native input hook.
// Supports either a keyboard key (default CapsLock) or a mouse side-button.
// Emits "down"/"up"/"tap"; "cancel" on Esc.
//
// Caveat: uiohook is a passive listener — it cannot swallow the key. So CapsLock
// still toggles caps state. We mitigate by force-clearing caps (and any toggle)
// after release via the OS, see clearCapsLock().

import { EventEmitter } from "events";
import { execFile } from "child_process";
import { CONFIG } from "./config";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { uIOhook, UiohookKey } = require("uiohook-napi");

export class PttHook extends EventEmitter {
  private isDown = false;
  private downAt = 0;
  private keycode: number | null = null;
  private confirmCode: number | null = null;

  start() {
    const useMouse = CONFIG.pttMouseButton != null;
    this.confirmCode = (UiohookKey as Record<string, number>)[CONFIG.confirmKey] ?? null;

    if (!useMouse) {
      this.keycode = (UiohookKey as Record<string, number>)[CONFIG.pttKey];
      if (this.keycode == null) {
        this.emit("log", `unknown PTT key "${CONFIG.pttKey}" — falling back to CapsLock`);
        this.keycode = UiohookKey.CapsLock;
      }
      uIOhook.on("keydown", (e: { keycode: number }) => {
        if (e.keycode === this.keycode) this.press();
      });
      uIOhook.on("keyup", (e: { keycode: number }) => {
        if (e.keycode === this.keycode) {
          this.release();
          if (this.keycode === UiohookKey.CapsLock) clearCapsLock();
        }
      });
    } else {
      uIOhook.on("mousedown", (e: { button: number }) => {
        if (e.button === CONFIG.pttMouseButton) this.press();
      });
      uIOhook.on("mouseup", (e: { button: number }) => {
        if (e.button === CONFIG.pttMouseButton) this.release();
      });
    }

    // Dedicated confirm key (separate from PTT) + Esc cancel.
    uIOhook.on("keydown", (e: { keycode: number }) => {
      if (e.keycode === UiohookKey.Escape) this.emit("cancel");
      else if (this.confirmCode != null && e.keycode === this.confirmCode) this.emit("confirm");
    });

    // Global mousewheel — forwarded so the (click-through) gem can scroll its
    // caption back. uiohook gives { rotation, x, y }: rotation<0 = wheel up.
    uIOhook.on("wheel", (e: { rotation: number; x: number; y: number }) => {
      this.emit("wheel", e);
    });

    // Global mouse move — used by main to drive click-through hit-testing in the
    // native thread (renderer-independent, so a starved renderer can't wedge it).
    uIOhook.on("mousemove", (e: { x: number; y: number }) => {
      this.emit("mousemove", e);
    });

    uIOhook.start();
    this.emit("log", (useMouse
      ? `PTT armed on mouse button ${CONFIG.pttMouseButton}`
      : `PTT armed on ${CONFIG.pttKey} (hold to talk)`)
      + `; confirm=${CONFIG.confirmKey}, cancel=Esc`);
  }

  private press() {
    if (this.isDown) return; // ignore auto-repeat
    this.isDown = true;
    this.downAt = Date.now();
    this.emit("log", "PTT down");
    this.emit("down");
  }

  private release() {
    if (!this.isDown) return;
    this.isDown = false;
    this.emit("log", `PTT up (held ${Date.now() - this.downAt}ms)`);
    this.emit("up");
  }

  stop() {
    try { uIOhook.stop(); } catch { /* ignore */ }
  }
}

// Force CapsLock back off after using it as PTT, so it doesn't leave caps engaged.
// Uses a tiny PowerShell SendKeys toggle only when the key is currently on.
function clearCapsLock() {
  const ps = [
    "Add-Type -AssemblyName System.Windows.Forms;",
    "if([System.Console]::CapsLock){[System.Windows.Forms.SendKeys]::SendWait('{CAPSLOCK}')}",
  ].join(" ");
  execFile("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], () => { /* best effort */ });
}
