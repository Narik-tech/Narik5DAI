/**
 * The Python service processes requests serially. Keep its backlog here, where
 * cancelled searches can release their queued positions without sending them.
 * An abandoned in-flight request still owns the slot until inference settles.
 */
export function createInferenceQueue(runtime) {
  const queue = [];
  let running = false;
  const aborted = () => Object.assign(new Error('Self-play search stopped.'), { name: 'AbortError' });

  async function drain() {
    if (running) return;
    running = true;
    try {
      while (queue.length) {
        const request = queue.shift();
        try { request.resolve(await runtime.evaluate(request.positions)); }
        catch (error) { request.reject(error); }
        finally { request.signal.removeEventListener('abort', request.cancel); }
      }
    } finally { running = false; }
  }

  return {
    evaluate(positions, { signal }) {
      if (signal.aborted) return Promise.reject(aborted());
      return new Promise((resolve, reject) => {
        const request = { positions, signal, resolve, reject, cancel() {
          const index = queue.indexOf(request);
          if (index !== -1) queue.splice(index, 1);
          signal.removeEventListener('abort', request.cancel);
          reject(aborted());
        } };
        signal.addEventListener('abort', request.cancel, { once: true });
        queue.push(request);
        void drain();
      });
    },
  };
}
