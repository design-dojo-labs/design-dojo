import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import type { FastifyInstance } from 'fastify';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

/** Serves the built frontend with SPA fallback. Paths are resolved strictly inside the dist folder. */
export function registerStatic(app: FastifyInstance, distDir: string): void {
  const root = resolve(distDir);
  app.get('/*', async (req, reply) => {
    const url = decodeURIComponent((req.url.split('?')[0] ?? '/').replace(/^\/+/, ''));
    if (url.startsWith('api/')) return reply.code(404).send({ error: 'Not found' });
    const indexFile = join(root, 'index.html');
    if (!existsSync(indexFile)) {
      return reply
        .code(503)
        .type('text/plain')
        .send('The web UI has not been built yet. Run `npm run build` (or use `npm start`, which builds it automatically).');
    }
    let file = indexFile;
    if (url && !url.includes('\0')) {
      const candidate = resolve(root, url);
      if (candidate.startsWith(root + sep) && existsSync(candidate) && statSync(candidate).isFile()) file = candidate;
    }
    const type = TYPES[extname(file)] ?? 'application/octet-stream';
    if (file !== indexFile && url.startsWith('assets/')) reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    else reply.header('Cache-Control', 'no-cache');
    return reply.type(type).send(readFileSync(file));
  });
}
