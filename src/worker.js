import { parentPort, workerData } from 'node:worker_threads';
import { analyze } from './search.js';
import { formatAction, validateAction } from './rules.js';

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
    notation: result.bestAction === null || result.bestAction === undefined
      ? '' : formatAction(workerData.position, result.bestAction),
    pvNotation,
  };
}

try {
  const cancelled = new Int32Array(workerData.cancelBuffer);
  const result = analyze(workerData.position, {
    ...workerData.options,
    shouldStop: () => Atomics.load(cancelled, 0) !== 0,
    onProgress: progress => parentPort.postMessage({ type: 'progress', result: annotate(progress) }),
  });
  parentPort.postMessage({ type: 'result', result: annotate(result) });
} catch (error) {
  parentPort.postMessage({ type: 'error', error: error.message });
}
