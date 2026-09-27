// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const ALL_CHECKS = [
  { name: 'typecheck', args: ['typecheck'] },
  { name: 'lint', args: ['lint'] },
  { name: 'test', args: ['test'] },
  { name: 'validate-config', args: ['validate-config'] },
] as const;

type CheckName = (typeof ALL_CHECKS)[number]['name'];

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

/**
 * Runs the named checks (all of them by default) concurrently, printing each in a fixed order once all finish so
 * output never interleaves. `test` carries CPU-time budget assertions against this project's real 10ms Workers
 * limit; running it alongside typecheck/lint on a CPU-constrained runner starves it and makes those budgets flake,
 * so CI keeps `test` in its own invocation instead of bundling it with the others.
 */
export async function runChecks(names: readonly CheckName[] = ALL_CHECKS.map((c) => c.name)): Promise<number> {
  const checks = ALL_CHECKS.filter((c) => names.includes(c.name));
  const results = await Promise.all(checks.map((c) => runCheck(c.name, [...c.args])));
  let status = 0;
  for (const result of results) {
    console.log(`\n--- ${result.name} ${result.code === 0 ? 'OK' : 'FAILED'} ---`);
    process.stdout.write(result.output);
    if (result.code !== 0) status = 1;
  }
  return status;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const requested = process.argv.slice(2) as CheckName[];
  runChecks(requested.length > 0 ? requested : undefined).then((code) => process.exit(code));
}
