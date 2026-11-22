import { useEffect, useRef, useState } from 'react';
import { supabase } from './lib.js';
// Live read: asks again every `ms` and when the tab comes back. Keeps the last good answer if one read fails.
export function useRpc(fn, args, deps = [], ms = 15000) {
  const [s, set] = useState({ data: null, error: null });
  const live = useRef(true);
  const load = () => (fn ? supabase.rpc(fn, args).then(({ data, error }) => { if (live.current) set((x) => ({ data: error ? x.data : data, error: error?.message || null })); }) : Promise.resolve());
  useEffect(() => {
    live.current = true; set((x) => ({ ...x, error: null })); load();
    const t = setInterval(load, ms); const vis = () => { if (!document.hidden) load(); }; document.addEventListener('visibilitychange', vis);
    return () => { live.current = false; clearInterval(t); document.removeEventListener('visibilitychange', vis); };
  }, deps);
  return [s.data, s.error, load];
}
