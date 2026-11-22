import { createClient } from '@supabase/supabase-js';
// Nexus uses the ShipBay project and the same floor logins. Three ways in:
//   standalone   its own session (admin, staff or floor PIN)
//   ?embed       inside the ShipBay WMS: no session, the WMS hands over the signed-in user's short-lived token (App.jsx)
//   ?window=floor|admin#k=<key>   inside any other site: no login at all, a connection key decides what the window shows
const q = new URLSearchParams(window.location.search);
export const EMBED = q.has('embed');
export const WINDOW = ['floor', 'admin'].includes(q.get('window')) ? q.get('window') : null;
export const WINDOW_KEY = WINDOW ? new URLSearchParams(window.location.hash.slice(1)).get('k') || '' : '';   // in the #fragment: never sent to a server or written to its logs
export const WMS_ORIGINS = ['https://wms.shipbay3pl.com', 'https://wmsshipbay.netlify.app'];
let token = null; export const setToken = (t) => { token = t; };
export const supabase = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_KEY,
  EMBED ? { accessToken: async () => token } : WINDOW ? { auth: { persistSession: false, autoRefreshToken: false, storageKey: 'nexus-window' } } : { auth: { storageKey: 'nexus-auth' } });
export const NEXUS_ROLES = ['shipbay_admin', 'shipbay_staff', 'wms_employee'];
export const num = (n) => Number(n || 0).toLocaleString('en-US');
export const day = (d) => (d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—');
export const stamp = (d) => (d ? new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—');
export const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const rpc = async (fn, args) => { const { data, error } = await supabase.rpc(fn, args); if (error) throw new Error(error.message); return data; };
