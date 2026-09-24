#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_PYTHON, PROJECT_ROOT } from '../src/transformer-runtime.js';

const [command, ...args] = process.argv.slice(2);
function run(executable, arguments_) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, arguments_, { cwd: PROJECT_ROOT, windowsHide: true, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Command exited with code ${code}.`)));
  });
}

async function main() {
  if (!command || command === '--help' || (command === 'setup' && args.includes('--help'))) {
    console.log('Usage: node scripts/transformer.js setup [--python PATH] [--cpu]\n       node scripts/transformer.js doctor|train|evaluate|test [options]\nSetup creates .venv-transformer and installs the official PyTorch wheel. Training defaults to artifacts/transformer/training.jsonl.');
    return;
  }
  if (command === 'setup') {
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--python' && args[i + 1] && !args[i + 1].startsWith('--')) { i++; continue; }
      if (args[i] !== '--cpu') throw new Error('Setup accepts --python PATH and --cpu. Use --help for usage.');
    }
    const index = args.indexOf('--python');
    const seed = index >= 0 ? args[index + 1] : process.env.TRANSFORMER_PYTHON || (process.platform === 'win32' ? 'py' : 'python3');
    if (!seed) throw new Error('--python requires a Python 3.10+ executable path.');
    if (!existsSync(DEFAULT_PYTHON)) {
      await run(seed, ['-m', 'venv', path.join(PROJECT_ROOT, '.venv-transformer')]);
    }
    await run(DEFAULT_PYTHON, ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-cache-dir', 'torch==2.14.0', '--index-url', `https://download.pytorch.org/whl/${args.includes('--cpu') ? 'cpu' : 'cu126'}`]);
    console.log('Transformer environment ready. Generate data, then train a checkpoint.');
    return;
  }
  const python = process.env.TRANSFORMER_PYTHON || DEFAULT_PYTHON;
  if (!existsSync(python)) throw new Error('Run npm run transformer:setup first (use -- --python PATH if needed).');
  if (command === 'test') {
    await run(python, ['-m', 'unittest', 'discover', '-s', 'neural', '-t', '.', ...args]);
    return;
  }
  const scripts = { doctor: 'doctor.py', train: 'train.py', evaluate: 'evaluate.py' };
  if (!scripts[command]) throw new Error('Usage: node scripts/transformer.js setup|doctor|train|evaluate|test [options]');
  await run(python, ['-u', path.join(PROJECT_ROOT, 'neural', scripts[command]), ...args]);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
