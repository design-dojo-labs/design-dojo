import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export interface SecurityOptions {
  port: number;
  extraOrigins: string[];
}

/**
 * Local-service protections:
 * - Host allow-list (blocks DNS-rebinding attacks that point a public name at 127.0.0.1).
 * - Origin check plus a per-process CSRF token header on every state-changing API request.
 *   A cross-origin page cannot read the token (no CORS headers are ever sent) and cannot set the
 *   custom header without a preflight that this server never approves.
 * - Restrictive response headers and CSP.
 */
export function installSecurity(app: FastifyInstance, opts: SecurityOptions): { token: string } {
  const token = randomBytes(24).toString('hex');
  const tokenBuf = Buffer.from(token);
  const hostPorts = [`127.0.0.1:${opts.port}`, `localhost:${opts.port}`, `[::1]:${opts.port}`];
  const allowedHosts = new Set(hostPorts);
  const allowedOrigins = new Set([...hostPorts.map((h) => `http://${h}`), ...opts.extraOrigins]);
  for (const o of opts.extraOrigins) {
    try {
      allowedHosts.add(new URL(o).host);
    } catch {
      /* ignore malformed */
    }
  }

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const host = String(req.headers.host ?? '').toLowerCase();
    if (!allowedHosts.has(host)) {
      return reply.code(421).send({ error: `Host "${host}" is not allowed. Open the studio at http://127.0.0.1:${opts.port}.` });
    }
    const origin = req.headers.origin;
    if (origin && !allowedOrigins.has(origin)) {
      return reply.code(403).send({ error: 'Cross-origin requests are not allowed.' });
    }
    const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    if (req.method === 'OPTIONS') return reply.code(403).send({ error: 'CORS is disabled.' });
    if (unsafe && req.url.startsWith('/api/')) {
      const sent = String(req.headers['x-studio-token'] ?? '');
      const ok = sent.length === token.length && timingSafeEqual(Buffer.from(sent), tokenBuf);
      if (!ok) return reply.code(403).send({ error: 'Missing or stale request token. Reload the page.', code: 'csrf' });
      const fetchSite = req.headers['sec-fetch-site'];
      if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
        return reply.code(403).send({ error: 'Cross-site requests are not allowed.' });
      }
    }
  });

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    if (!req.url.startsWith('/api/')) {
      reply.header(
        'Content-Security-Policy',
        [
          "default-src 'self'",
          "script-src 'self'",
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data: blob:",
          "font-src 'self' data:",
          "worker-src 'self' blob:",
          "connect-src 'self'",
          "frame-ancestors 'none'",
          "base-uri 'none'",
          "form-action 'none'",
        ].join('; '),
      );
    } else {
      reply.header('Cache-Control', 'no-store');
    }
    return payload;
  });

  return { token };
}
