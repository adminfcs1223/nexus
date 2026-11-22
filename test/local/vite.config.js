// Local harness build. Refuses any backend but the local gateway; reads no .env file.
import react from '@vitejs/plugin-react'; import { defineConfig } from 'vite'; import path from 'node:path';
export default defineConfig(() => {
  if (process.env.VITE_SUPABASE_URL !== 'http://127.0.0.1:54341') throw new Error('REFUSED: backend must be http://127.0.0.1:54341');
  return { root: __dirname, envDir: path.resolve(__dirname, 'no-env'), publicDir: path.resolve(__dirname, '../../public'), plugins: [react()], build: { outDir: process.env.OUT || '/tmp/nexus-local/build', emptyOutDir: true } };
});
