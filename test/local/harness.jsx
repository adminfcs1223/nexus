// The real Nexus screens over the local synthetic database. Only the sign-in shell is skipped (no GoTrue locally).
import { StrictMode } from 'react'; import { createRoot } from 'react-dom/client';
import '@fontsource/orbitron/700.css'; import '@fontsource/orbitron/800.css'; import '../../src/nexus.css'; import Nexus from '../../src/Nexus.jsx'; import Window from '../../src/Window.jsx'; import { WINDOW } from '../../src/lib.js';
const who = new URLSearchParams(location.search).get('as') || 'admin';
const ME = { admin: { id: 'aa000000-0000-4000-8000-000000000002', role: 'shipbay_admin', full_name: 'Test Admin' }, floor: { id: 'aa000000-0000-4000-8000-000000000001', role: 'wms_employee', full_name: 'Test Floor' } }[who];
createRoot(document.getElementById('root')).render(<StrictMode>{WINDOW ? <Window /> : <Nexus me={ME} onSignOut={() => {}} />}</StrictMode>);
