// Global push-to-talk via uiohook-napi. Electron's globalShortcut can't reliably
// do hold-to-talk (no keyup, no mouse buttons), so we use a native input hook.
// Supports either a keyboard key (default Right-Ctrl, "CtrlRight") or a mouse side-button.
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
  // Stuck-key guards (issue #107). The sweep timer runs ONLY while held.
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  // Last time we saw a keydown for our PTT key (incl. OS auto-repeat while held).
  private lastKeydownAt = 0;
  // True when the active press came from a mouse button (no auto-repeat → the
  // sweep's staleness signal doesn't apply; the max-hold backstop covers it).
  private downFromMouse = false;

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
        if (e.keycode === this.keycode) {
          // Every keydown — including OS auto-repeat while physically held —
          // refreshes the liveness timestamp the sweep uses to detect a stuck key.
          this.lastKeydownAt = Date.now();
          this.press(false);
        }
      });
      uIOhook.on("keyup", (e: { keycode: number }) => {
        if (e.keycode === this.keycode) {
          this.release();
          if (this.keycode === UiohookKey.CapsLock) clearCapsLock();
        }
      });
    } else {
      uIOhook.on("mousedown", (e: { button: number }) => {
        if (e.button === CONFIG.pttMouseButton) this.press(true);
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

  private press(fromMouse: boolean) {
    if (this.isDown) return; // ignore auto-repeat
    this.isDown = true;
    this.downFromMouse = fromMouse;
    this.downAt = Date.now();
    this.emit("log", "PTT down");
    this.emit("down");
    this.startSweep();
  }

  private release() {
    if (!this.isDown) return;
    this.isDown = false;
    this.stopSweep();
    this.emit("log", `PTT up (held ${Date.now() - this.downAt}ms)`);
    this.emit("up");
  }

  // Stuck-key watchdog (issue #107). Runs ONLY while held; cleared on release.
  // Two guards, both funneled through release() so the normal "up" path (stop
  // capture, flush, stop re-transcription) always runs:
  //   1) auto-repeat staleness — for the keyboard case, the OS emits periodic
  //      keydown auto-repeat while a key is physically held, refreshing
  //      lastKeydownAt. If we're "down" but no keydown has arrived within
  //      pttStaleMs, the key is no longer held (the keyup was missed) → release.
  //      We chose auto-repeat over polling GetAsyncKeyState because the latter
  //      needs a uiohook-keycode→Win32-VK map and a per-tick PowerShell spawn
  //      (expensive on a 1.5s loop, Windows-only); auto-repeat is a free,
  //      cross-platform signal already flowing through the existing hook. Its one
  //      gap — mouse buttons don't auto-repeat — is covered by guard (2).
  //   2) max-hold backstop — force release once held past pttMaxHoldMs no matter
  //      what; the guaranteed catch-all (and the only physical check for mouse).
  private startSweep() {
    this.stopSweep();
    this.sweepTimer = setInterval(() => {
      if (!this.isDown) { this.stopSweep(); return; }
      const now = Date.now();
      const held = now - this.downAt;
      if (held >= CONFIG.pttMaxHoldMs) {
        this.emit("log", `PTT force-released after max-hold (${held}ms)`);
        this.release();
        return;
      }
      // Auto-repeat staleness applies to the keyboard case only (mouse buttons
      // don't auto-repeat — guard (2) above is their backstop). Give the first
      // repeat time to arrive by waiting at least pttStaleMs after the press.
      if (!this.downFromMouse && held >= CONFIG.pttStaleMs &&
          now - this.lastKeydownAt >= CONFIG.pttStaleMs) {
        this.emit("log", "PTT force-released — stuck key detected by sweep");
        this.release();
      }
    }, CONFIG.pttSweepMs);
    // Don't let the watchdog hold the event loop / process open.
    this.sweepTimer.unref?.();
  }

  private stopSweep() {
    if (this.sweepTimer) { clearInterval(this.sweepTimer); this.sweepTimer = null; }
  }

  stop() {
    this.stopSweep();
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
