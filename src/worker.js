import { parentPort, workerData } from 'node:worker_threads';
import { analyze } from './search.js';
import { formatAction, validateAction } from './rules.js';

let contextTruncated = false, frontierTruncated = false;
let requestId = 0;
const pending = new Map();
if (workerData.options.engine === 'transformer') {
  parentPort.on('message', message => {
    if (message.type !== 'evaluations') return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error));
    else {
      contextTruncated ||= message.context?.some(item => item.truncated) ?? false;
      frontierTruncated ||= message.context?.some(item => item.frontierTruncated) ?? false;
      request.resolve(message.values);
    }
  });
}

function evaluateBatch(positions) {
  const id = ++requestId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    parentPort.postMessage({ type: 'evaluate', id, positions });
  });
}

function annotate(result) {
  let position = workerData.position;
  const pvNotation = [];
  for (const action of result.pv ?? []) {
    try {
      pvNotation.push(formatAction(position, action));
      position = validateAction(position, action);
    } catch { break; }
  }
  return {
    ...result,
    engine: workerData.options.engine || 'classical',
    ...(workerData.options.engine === 'transformer' ? { model: workerData.model, contextTruncated, frontierTruncated } : {}),
    notation: result.bestAction === null || result.bestAction === undefined
      ? '' : formatAction(workerData.position, result.bestAction),
    pvNotation,
  };
}

try {
  const cancelled = new Int32Array(workerData.cancelBuffer);
  const engine = workerData.options.engine === 'transformer' ? (await import('./transformer-search.js')).analyze : analyze;
  const result = await engine(workerData.position, {
    ...workerData.options,
    shouldStop: () => Atomics.load(cancelled, 0) !== 0,
    evaluateBatch,
    onProgress: progress => parentPort.postMessage({ type: 'progress', result: annotate(progress) }),
  });
  parentPort.postMessage({ type: 'result', result: annotate(result) });
} catch (error) {
  parentPort.postMessage({ type: 'error', error: error.message });
} finally {
  parentPort.close();
}
