import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { cpSync, createReadStream, existsSync, statSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { createRequire } from 'node:module';

const serverPort = Number(process.env.LLD_STUDIO_PORT ?? 4317);
const require = createRequire(import.meta.url);
// Excalidraw loads its fonts from window.EXCALIDRAW_ASSET_PATH (otherwise a public CDN). Serve them locally.
const excalidrawFonts = join(dirname(require.resolve('@excalidraw/excalidraw')), 'fonts'); // <pkg>/dist/prod/fonts

function excalidrawAssets(): Plugin {
  return {
    name: 'excalidraw-local-assets',
    configureServer(server) {
      server.middlewares.use('/excalidraw-assets/fonts', (req, res, next) => {
        const file = normalize(join(excalidrawFonts, decodeURIComponent((req.url ?? '').split('?')[0])));
        if (!file.startsWith(excalidrawFonts) || !existsSync(file) || !statSync(file).isFile()) return next();
        res.setHeader('Content-Type', 'font/woff2');
        createReadStream(file).pipe(res);
      });
    },
    writeBundle(opts) {
      cpSync(excalidrawFonts, join(opts.dir ?? 'dist', 'excalidraw-assets', 'fonts'), { recursive: true });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwind(), excalidrawAssets()],
  define: { 'process.env.IS_PREACT': JSON.stringify('false') },
  // Exactly one React instance, even if a dependency's peer range pulls in another copy.
  resolve: { dedupe: ['react', 'react-dom'] },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/api': { target: `http://127.0.0.1:${serverPort}`, changeOrigin: true } },
  },
  build: { outDir: 'dist', chunkSizeWarningLimit: 8000, sourcemap: false },
});
