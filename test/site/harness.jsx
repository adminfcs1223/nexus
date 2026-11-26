// Local preview of the three live screens with made-up data. Never deployed; talks to nothing.
import { createRoot } from 'react-dom/client';
import '@fontsource/orbitron/700.css'; import '@fontsource/orbitron/800.css'; import '../../src/nexus.css';
import Site from '../../src/Site.jsx'; import fixture from './fixture.json';
const f = new URLSearchParams(location.search).get('f') || 'blank';
const blank = { ...fixture, positions: fixture.positions.map((p) => ({ ...p, status: 'open', status_reason: null, used: 0, occupants: [] })), pallets: [], calendar: [] };
const load = f === 'error' ? () => Promise.reject(new Error('Nexus could not answer.')) : () => Promise.resolve(f === 'occupied' ? fixture : blank);
createRoot(document.getElementById('root')).render(<Site me={{ full_name: 'Local Preview' }} onSignOut={() => {}} load={load} embed={new URLSearchParams(location.search).has('embed')} />);
