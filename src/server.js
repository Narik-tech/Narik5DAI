import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { GameSession } from './session.js';

const PUBLIC = new URL('../public/', import.meta.url);
const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
]);

function numericOption(value, fallback, min, max, name) {
  const number = value === undefined ? fallback : Number(value);
  const validType = value === undefined || typeof value === 'number' || (typeof value === 'string' && value.trim() !== '');
  if (!validType || !Number.isFinite(number) || !Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return number;
}

async function readBody(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) {
    throw new Error('Requests must use application/json.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 512 * 1024) throw new Error('Request exceeds the 512 KB limit.');
    chunks.push(chunk);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object.');
  return value;
}

export function createApp() {
  const game = new GameSession();
  const jobs = new Map();
  const stopJobs = () => {
    for (const job of jobs.values()) {
      if (job.status === 'running') Atomics.store(job.cancelled, 0, 1);
    }
  };
  const publicJob = job => ({
    jobId: job.id, status: job.status, revision: job.revision,
    progress: job.progress, result: job.result, error: job.error,
  });
  const send = (res, status, value) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  };

  const server = http.createServer(async (req, res) => {
    try {
      const host = req.headers.host ?? '';
      if (!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host)) {
        return send(res, 403, { error: 'This service accepts local requests only.' });
      }
      if (req.headers.origin && ![`http://${host}`, `https://${host}`].includes(req.headers.origin)) {
        return send(res, 403, { error: 'Cross-origin requests are not allowed.' });
      }
      const url = new URL(req.url, `http://${host}`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'");
      if (req.method === 'GET' && staticFiles.has(url.pathname)) {
        const [name, type] = staticFiles.get(url.pathname);
        const content = await readFile(new URL(name, PUBLIC));
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
        return res.end(content);
      }
      if (req.method === 'GET' && url.pathname === '/api/game') return send(res, 200, game.snapshot());
      const jobMatch = /^\/api\/analysis\/([a-zA-Z0-9-]+)(\/stop)?$/.exec(url.pathname);
      if (jobMatch) {
        const job = jobs.get(jobMatch[1]);
        if (!job) return send(res, 404, { error: 'Analysis job not found.' });
        if (req.method === 'POST' && jobMatch[2]) {
          await readBody(req);
          Atomics.store(job.cancelled, 0, 1);
          return send(res, 200, publicJob(job));
        }
        if (req.method === 'GET' && !jobMatch[2]) return send(res, 200, publicJob(job));
      }
      if (req.method !== 'POST') return send(res, 404, { error: 'Not found.' });
      const body = await readBody(req);
      switch (url.pathname) {
        case '/api/new':
          if (body.variant !== undefined && !game.chess.variants.some(v => v.shortName === body.variant && v.shortName !== 'custom')) {
            throw new Error('Unknown board variant.');
          }
          game.reset({ variant: body.variant });
          stopJobs();
          break;
        case '/api/import':
          if (typeof body.pgn !== 'string' || !body.pgn.trim()) throw new Error('Enter a 5DPGN game or 5DFEN position.');
          game.reset({ pgn: body.pgn });
          stopJobs();
          break;
        case '/api/move':
          game.assertRevision(body.revision);
          game.move(body.move);
          stopJobs();
          break;
        case '/api/submit':
          game.assertRevision(body.revision);
          game.submit();
          stopJobs();
          break;
        case '/api/undo':
          game.undo();
          stopJobs();
          break;
        case '/api/analyze': {
          const options = {
            timeMs: numericOption(body.timeMs, 3000, 50, 120000, 'Think time'),
            maxDepth: numericOption(body.maxDepth, 8, 1, 16, 'Depth'),
            maxNodes: numericOption(body.maxNodes, 2000000, 1, 1000000000, 'Node budget'),
            cacheMemoryMb: numericOption(body.cacheMemoryMb, 128, 0, 4096, 'Cache memory'),
            maxTableEntries: 1000000,
            quiescenceDepth: numericOption(body.quiescenceDepth, 2, 0, 6, 'Quiescence depth'),
          };
          stopJobs();
          // A bounded cache retains completed results for Play best and inspection.
          for (const [id, old] of jobs) {
            if (jobs.size < 12) break;
            if (old.status !== 'running') jobs.delete(id);
          }
          if ([...jobs.values()].filter(j => j.status === 'running').length >= 2) {
            return send(res, 429, { error: 'Previous searches are stopping. Try again in a moment.' });
          }
          const cancelled = new Int32Array(new SharedArrayBuffer(4));
          const job = { id: randomUUID(), status: 'running', revision: game.revision, cancelled };
          const worker = new Worker(new URL('./worker.js', import.meta.url), {
            workerData: { position: game.position, options, cancelBuffer: cancelled.buffer },
          });
          job.worker = worker;
          jobs.set(job.id, job);
          // Guard non-interruptible upstream move generation as well as our cooperative timer.
          const hardDeadline = setTimeout(() => {
            if (job.status !== 'running') return;
            job.result = job.progress ? { ...job.progress, stoppedReason: 'hard-time-limit' } : undefined;
            job.status = job.result?.bestAction ? 'done' : 'cancelled';
            job.error = 'Hard time limit reached; showing the last completed search result.';
            void worker.terminate();
          }, options.timeMs + 5000);
          hardDeadline.unref();
          worker.on('message', message => {
            if (job.status !== 'running') return;
            if (message.type === 'progress') job.progress = message.result;
            if (message.type === 'result') { job.result = message.result; job.status = 'done'; clearTimeout(hardDeadline); }
            if (message.type === 'error') { job.error = message.error; job.status = 'error'; clearTimeout(hardDeadline); }
          });
          worker.on('error', error => { job.error = error.message; job.status = 'error'; clearTimeout(hardDeadline); });
          worker.on('exit', code => {
            clearTimeout(hardDeadline);
            if (job.status === 'running') { job.status = 'error'; job.error = `Search worker exited (${code}).`; }
          });
          return send(res, 202, { jobId: job.id });
        }
        case '/api/play': {
          game.assertRevision(body.revision);
          const job = jobs.get(body.jobId);
          if (!job || job.revision !== game.revision) throw new Error('This analysis belongs to a different position.');
          if (job.status !== 'done' || !Array.isArray(job.result?.bestAction)) throw new Error('No completed legal recommendation is available.');
          game.play(job.result.bestAction);
          stopJobs();
          break;
        }
        default: return send(res, 404, { error: 'Not found.' });
      }
      return send(res, 200, game.snapshot());
    } catch (error) {
      if (!res.headersSent) send(res, error.statusCode ?? 400, { error: error.message });
      else res.end();
    }
  });
  server.on('close', () => { for (const job of jobs.values()) void job.worker.terminate(); });
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT ?? 5173);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be a valid local port.');
  const app = createApp();
  app.listen(port, '127.0.0.1', () => console.log(`Vibe-D AI is ready at http://127.0.0.1:${app.address().port}`));
  app.on('error', error => { console.error(error.message); process.exitCode = 1; });
}
