// Local preview build of the Stage 1 screens. No backend, no .env.
import react from '@vitejs/plugin-react'; import { defineConfig } from 'vite'; import path from 'node:path';
export default defineConfig({ root: __dirname, envDir: path.resolve(__dirname, '../local/no-env'), publicDir: path.resolve(__dirname, '../../public'), plugins: [react()], build: { outDir: process.env.OUT || '/tmp/nexus-site-preview', emptyOutDir: true } });
