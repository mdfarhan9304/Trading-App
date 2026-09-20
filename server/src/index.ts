import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import express from 'express';
import { createRouter } from './api/routes';
import { PORT, SEED, SYMBOL, TRADES_PER_SEC } from './config';
import { MarketEngine } from './engine/marketEngine';
import { WsHub } from './ws/wsServer';

function lanAddress(): string | undefined {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      // IPv4, not loopback, not a virtual/link-local interface.
      if (address.family === 'IPv4' && !address.internal && !address.address.startsWith('169.254.')) {
        return address.address;
      }
    }
  }
  return undefined;
}

function main(): void {
  const engine = new MarketEngine();
  const hub = new WsHub(engine);

  const app = express();

  // Modest body limit: the only POST bodies we accept are two-field debug commands.
  app.use(express.json({ limit: '16kb' }));

  app.use((_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    next();
  });
  app.options('/*splat', (_req, res) => {
    res.sendStatus(204);
  });

  app.get('/health', (_req, res) => {
    res.json({ ok: true, symbol: SYMBOL, connections: hub.count, uptimeSec: Math.round(process.uptime()) });
  });

  app.use('/api/v1', createRouter(engine, hub));

  // Anything unmatched is a 404 in JSON rather than Express's HTML page, so a client's
  // error handling sees a consistent content type.
  app.use((_req, res) => {
    res.status(404).json({ error: 'not found' });
  });

  const server = createServer(app);
  hub.attach(server, '/stream');

  server.listen(PORT, () => {
    const lan = lanAddress();
    const line = '-'.repeat(66);
    console.log(line);
    console.log(`  TwoSpoon market-data backend`);
    console.log(line);
    console.log(`  symbol        ${SYMBOL}`);
    console.log(`  seed          ${SEED}   (set SEED=n to replay a different market)`);
    console.log(`  trade rate    ~${TRADES_PER_SEC}/s`);
    console.log(`  REST          http://localhost:${PORT}/api/v1`);
    console.log(`  WebSocket     ws://localhost:${PORT}/stream`);
    console.log(line);
    console.log(`  Android emulator uses the host alias 10.0.2.2:`);
    console.log(`    http://10.0.2.2:${PORT}/api/v1     ws://10.0.2.2:${PORT}/stream`);
    if (lan) {
      console.log(`  Physical device on the same Wi-Fi:`);
      console.log(`    http://${lan}:${PORT}/api/v1     ws://${lan}:${PORT}/stream`);
    }
    console.log(line);
    engine.start();
  });

  /**
   * Shut down cleanly so that repeated `npm run backend` never hits EADDRINUSE, and so
   * timers do not keep the process alive after Ctrl+C.
   */
  const shutdown = (signal: string): void => {
    console.log(`\n${signal} received, shutting down`);
    engine.stop();
    hub.close();
    server.close(() => process.exit(0));
    // If a socket refuses to close, do not hang forever.
    setTimeout(() => process.exit(0), 2_000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
