// A Cabine: the shell's cards, outside any screen.
//
//   makePinCard({fetch})          .cab-pin: the in-app PIN (the shell is public,
//                                 /api/ is not). ask() -> Promise<bool>, one card
//                                 at a time; posts {pin} to /auth, which sets the
//                                 dj_auth cookie. "later" resolves false.
//   installCard(onClose)          .cab-install: first run (and the crate's "?"):
//                                 how to put A Cabine on the home screen, and the
//                                 help lines. Inline at the top of the crate, so
//                                 it never covers a control.
//   makeResumeVeil(onTap)         .cab-resume: "tap to resume" after a phone call,
//                                 Siri, another app or AirPods taken off suspended
//                                 the audio.
//
// Copy rules: no em dashes, no emojis.

export const INSTALL_SEEN_KEY = "cabine_install_seen";
export const IOS_STEPS = "Share, then Add to Home Screen";
export const ANDROID_STEPS = "Chrome menu, Add to Home screen";
export const BLUETOOTH_HELP = "Bluetooth headphones lag a little; wired is tighter for jog and pads.";

const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent)
  || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

export function isInstalled() {
  const mm = (q) => typeof matchMedia === "function" && matchMedia(q).matches;
  return mm("(display-mode: standalone)") || mm("(display-mode: fullscreen)") || navigator.standalone === true;
}

// ---- PIN --------------------------------------------------------------------------

export function makePinCard({ fetch: fetchFn = (...a) => globalThis.fetch(...a), host = document.body } = {}) {
  let open = null;            // {el, promise}
  const card = {
    asks: 0,
    get isOpen() { return !!open; },
    ask() {
      if (open) return open.promise;
      card.asks++;
      const el = document.createElement("div");
      el.className = "cab-pin";
      el.setAttribute("role", "dialog");
      el.setAttribute("aria-modal", "true");
      el.setAttribute("aria-labelledby", "cab-pin-h");
      el.innerHTML = `
        <form class="cab-pin-card" novalidate>
          <p class="cab-pin-kicker">A Cabine</p>
          <h2 class="cab-pin-h" id="cab-pin-h">PIN</h2>
          <p class="cab-pin-why">The server asks for the PIN. The board and the tracks on this phone work without it.</p>
          <input class="cab-pin-input" type="password" inputmode="numeric" autocomplete="current-password"
            aria-label="PIN" maxlength="12">
          <p class="cab-pin-msg" aria-live="polite"></p>
          <div class="cab-pin-row">
            <button type="button" class="cab-btn cab-btn-quiet" data-pin="later">later</button>
            <button type="submit" class="cab-btn cab-btn-terra" data-pin="enter">enter</button>
          </div>
        </form>`;
      host.appendChild(el);
      const form = el.querySelector("form");
      const input = el.querySelector("input");
      const msg = el.querySelector(".cab-pin-msg");
      let resolve;
      const promise = new Promise((r) => { resolve = r; });
      let sending = false;
      const close = (ok) => {
        el.remove();
        open = null;
        resolve(ok);
      };
      const send = async () => {
        if (sending || !input.value) return;
        sending = true;
        msg.textContent = "";
        try {
          const r = await fetchFn("/auth", {
            method: "POST", credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ pin: input.value }),
          });
          if (r.ok) { close(true); return; }
          input.value = "";
          msg.textContent = r.status === 401 ? "Not that one. Try again." : `The server said ${r.status}. Try again.`;
        } catch (e) {
          msg.textContent = "No signal. Try again when the phone is online.";
        } finally {
          sending = false;
        }
      };
      form.addEventListener("submit", (e) => { e.preventDefault(); send(); });
      input.addEventListener("input", () => { if (input.value.length >= 4) send(); });
      el.querySelector("[data-pin=later]").addEventListener("click", () => close(false));
      open = { el, promise };
      setTimeout(() => { try { input.focus(); } catch (e) { /* fine */ } }, 0);
      return promise;
    },
  };
  return card;
}

// ---- install and help ----------------------------------------------------------------

export function installCard(onClose) {
  const el = document.createElement("section");
  el.className = "cab-install";
  el.setAttribute("aria-labelledby", "cab-install-h");
  const ios = isIos();
  const installed = isInstalled();
  const steps = [
    `<li class="cab-install-step${ios ? " cab-install-mine" : ""}" data-os="ios"><b>iPhone</b><span>${IOS_STEPS}</span></li>`,
    `<li class="cab-install-step${ios ? "" : " cab-install-mine"}" data-os="android"><b>Android</b><span>${ANDROID_STEPS}</span></li>`,
  ];
  if (!ios) steps.reverse();
  el.innerHTML = `
    <p class="cab-install-kicker">${installed ? "help" : "first run"}</p>
    <h2 class="cab-install-h" id="cab-install-h">${installed ? "A Cabine is on the home screen" : "Put A Cabine on the home screen"}</h2>
    ${installed ? "" : `<p>Installed, it opens full screen with no signal and keeps what you carry:
      Safari can clear a website's storage after 7 days without a visit, a home-screen app keeps it.</p>
    <ol class="cab-install-steps">${steps.join("")}</ol>
    <p>Install first, then carry: the home-screen app has its own storage, so tracks carried in the browser stay in the browser.</p>`}
    <p>Recordings wait on the phone and go to O Arquivo when there is signal. On the iPhone a ride is recorded in 5-minute parts, so a crash loses at most the part it was in.</p>
    <p class="cab-install-help">${BLUETOOTH_HELP}</p>
    <button type="button" class="cab-btn cab-btn-ink" data-install="close">got it</button>`;
  el.querySelector("[data-install=close]").addEventListener("click", () => {
    try { localStorage.setItem(INSTALL_SEEN_KEY, "1"); } catch (e) { /* private mode */ }
    el.remove();
    onClose && onClose();
  });
  return el;
}

export function installSeen() {
  try { return localStorage.getItem(INSTALL_SEEN_KEY) === "1"; } catch (e) { return true; }
}

// ---- the resume veil ------------------------------------------------------------------

export function makeResumeVeil(onTap, host = document.body) {
  let el = null;
  return {
    shows: 0,
    get isShown() { return !!el; },
    show() {
      if (el) return;
      this.shows++;
      el = document.createElement("div");
      el.className = "cab-resume";
      el.setAttribute("role", "button");
      el.setAttribute("tabindex", "0");
      el.innerHTML = `<div class="cab-resume-card"><b>tap to resume</b><span>the audio stopped (a call, Siri, another app or the headphones). Both decks pick up where they were.</span></div>`;
      el.addEventListener("pointerup", (e) => { e.preventDefault(); onTap(); });
      el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") onTap(); });
      host.appendChild(el);
    },
    hide() {
      if (!el) return;
      el.remove();
      el = null;
    },
  };
}
