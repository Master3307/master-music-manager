// "Install as an app". Chrome, Edge and Android hand us a prompt to show
// later; iPhones and iPads never do, so for them we explain the two taps.
import { useEffect, useState } from 'react';

let prompt = null;
const listeners = new Set();
const tell = () => listeners.forEach((fn) => fn());
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // we offer it in our own menu instead of the browser's mini bar
    prompt = e;
    tell();
  });
  window.addEventListener('appinstalled', () => {
    prompt = null;
    tell();
  });
}

export const installed = () => typeof window !== 'undefined' && (matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: window-controls-overlay)').matches || navigator.standalone === true);
export const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/** { can, ios, done, install() } */
export function useInstall() {
  const [, force] = useState(0);
  useEffect(() => {
    const fn = () => force((x) => x + 1);
    listeners.add(fn);
    return () => listeners.delete(fn);
  }, []);
  return {
    done: installed(),
    can: Boolean(prompt),
    ios: !installed() && isIos(),
    install: async () => {
      if (!prompt) return false;
      prompt.prompt();
      const { outcome } = await prompt.userChoice;
      prompt = null;
      tell();
      return outcome === 'accepted';
    },
  };
}
