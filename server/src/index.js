// HMS API - Phase 1 (mileage core)
import dns from 'node:dns';
import net from 'node:net';
import path from 'node:path';

// Containers without an IPv6 route + long-RTT hosts (e.g. Telegram) break
// fetch's happy-eyeballs defaults: prefer IPv4 and allow slower connects.
dns.setDefaultResultOrder('ipv4first');
net.setDefaultAutoSelectFamilyAttemptTimeout(2500);
import fs from 'node:fs';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { authRoutes } from './routes/auth.js';
import { userRoutes } from './routes/users.js';
import { catalogRoutes } from './routes/catalog.js';
import { earnRoutes } from './routes/earn.js';
import { spendRoutes } from './routes/spend.js';
import { ledgerRoutes } from './routes/ledger.js';
import { adminRoutes } from './routes/admin.js';
import { pushRoutes } from './routes/push.js';
import { telegramRoutes } from './routes/telegram.js';
import { opsRoutes } from './routes/ops.js';
import { initPush } from './push.js';

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 3000);
const UPLOAD_DIR = process.env.UPLOAD_DIR || '/data/uploads';

export function buildApp() {
  const app = Fastify({ logger: true, bodyLimit: 1048576 });

  if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET env is required');
  }
  app.register(jwt, { secret: process.env.JWT_SECRET, sign: { expiresIn: '30d' } });
  app.register(multipart, { limits: { fileSize: 8 * 1024 * 1024, files: 1 } });

  fs.mkdirSync(UPLOAD_DIR, { recursive: true });

  // auth decorators
  app.decorate('authRequired', async (req, reply) => {
    try {
      await req.jwtVerify();
    } catch {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  });
  app.decorate('parentOnly', async (req, reply) => {
    try {
      await req.jwtVerify();
    } catch {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    if (req.user.role !== 'parent') {
      return reply.code(403).send({ error: 'parent_only' });
    }
  });
  app.decorate('adminOnly', async (req, reply) => {
    try {
      await req.jwtVerify();
    } catch {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    if (req.user.role !== 'super_admin') {
      return reply.code(403).send({ error: 'admin_only' });
    }
  });

  app.get('/api/health', async () => ({
    status: 'ok',
    service: 'hms-api',
    version: process.env.APP_VERSION || '1.5.1',
    time: new Date().toISOString(),
  }));

  // proof photos (auth required; family scope checked by opaque filename)
  app.register(fastifyStatic, {
    root: path.resolve(UPLOAD_DIR),
    prefix: '/api/uploads/',
    decorateReply: false,
    setHeaders(res) { res.setHeader('cache-control', 'private, max-age=86400'); },
  });
  app.addHook('onRequest', async (req, reply) => {
    if (req.url.startsWith('/api/uploads/')) {
      try { await req.jwtVerify(); } catch { return reply.code(401).send({ error: 'unauthorized' }); }
    }
  });

  app.register(authRoutes, { prefix: '/api' });
  app.register(userRoutes, { prefix: '/api' });
  app.register(catalogRoutes, { prefix: '/api' });
  app.register(earnRoutes, { prefix: '/api', uploadDir: UPLOAD_DIR });
  app.register(spendRoutes, { prefix: '/api' });
  app.register(ledgerRoutes, { prefix: '/api' });
  app.register(adminRoutes, { prefix: '/api' });
  app.register(pushRoutes, { prefix: '/api' });
  app.register(telegramRoutes, { prefix: '/api' });
  app.register(opsRoutes, { prefix: '/api' });

  return app;
}

if (process.argv[1] && process.argv[1].endsWith('index.js')) {
  const app = buildApp();
  initPush()
    .then(() => app.log.info('web push ready'))
    .catch((err) => app.log.warn({ err: err.message }, 'web push init failed'))
    .finally(() => {
      app.listen({ host: HOST, port: PORT }).catch((err) => {
        app.log.error(err);
        process.exit(1);
      });
    });
}
