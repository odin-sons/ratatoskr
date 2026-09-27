// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const CHECKS = [
  { name: 'typecheck', args: ['typecheck'] },
  { name: 'lint', args: ['lint'] },
  { name: 'test', args: ['test'] },
  { name: 'validate-config', args: ['validate-config'] },
] as const;

interface CheckResult {
  name: string;
  code: number;
  output: string;
}

function runCheck(name: string, args: string[]): Promise<CheckResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(`pnpm ${args.join(' ')}`, { shell: true });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk));
    child.on('close', (code) => resolvePromise({ name, code: code ?? 1, output }));
  });
}

/** Runs every check concurrently; prints each in a fixed order once all finish, so output never interleaves. */
export async function runChecks(): Promise<number> {
  const results = await Promise.all(CHECKS.map((c) => runCheck(c.name, [...c.args])));
  let status = 0;
  for (const result of results) {
    console.log(`\n--- ${result.name} ${result.code === 0 ? 'OK' : 'FAILED'} ---`);
    process.stdout.write(result.output);
    if (result.code !== 0) status = 1;
  }
  return status;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runChecks().then((code) => process.exit(code));
}
