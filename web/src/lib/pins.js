// Quick play: things you want to start with one click (an artist, a genre,
// a playlist, an album or any filter). Kept in this browser and, when logged
// in, in your account.
import { useCallback, useEffect, useState } from 'react';
import { put } from './api.js';
import { store } from './util.js';

const listeners = new Set();
// "Shuffle everything" has its own big button on the home page, so it's no
// pin any more (older saved lists drop it too).
const noShuffle = (l) => (Array.isArray(l) ? l.filter((p) => p.type !== 'shuffle') : l);
let pins = noShuffle(store.get('pins', null));

export const DEFAULT_PINS = [
  { type: 'recent', name: 'Recently added' },
  { type: 'favorites', name: 'Your favorites' },
  { type: 'forgotten', name: 'Not played in a while' },
];

function save(next) {
  pins = next;
  store.set('pins', next);
  for (const fn of listeners) fn(next);
  put('account/prefs', { pins: next }).catch(() => {});
}

export function usePins() {
  const [list, setList] = useState(pins || DEFAULT_PINS);
  useEffect(() => {
    listeners.add(setList);
    return () => listeners.delete(setList);
  }, []);
  const add = useCallback((pin) => {
    const cur = pins || DEFAULT_PINS;
    if (cur.some((p) => p.type === pin.type && (p.id || p.name) === (pin.id || pin.name))) return;
    save([...cur, pin]);
  }, []);
  const remove = useCallback((i) => save((pins || DEFAULT_PINS).filter((_, j) => j !== i)), []);
  const move = useCallback((from, to) => {
    const c = (pins || DEFAULT_PINS).slice();
    const [x] = c.splice(from, 1);
    c.splice(to, 0, x);
    save(c);
  }, []);
  const reset = useCallback(() => save(DEFAULT_PINS), []);
  return { list, add, remove, move, reset };
}

/** Load pins from the account once after login. */
export function adoptPins(fromAccount) {
  if (Array.isArray(fromAccount) && fromAccount.length && !store.get('pins', null)) {
    pins = noShuffle(fromAccount);
    store.set('pins', pins);
    for (const fn of listeners) fn(pins);
  }
}
