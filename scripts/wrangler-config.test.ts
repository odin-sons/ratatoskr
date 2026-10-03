// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { buildDeployConfig, collectDatabaseId, collectInstanceNames, defaultDatabaseName, stripLeadingSeparator, withGeneratedConfig } from './wrangler-config.ts';

const ID = 'deadbeef-dead-beef-dead-beefdeadbeef';

describe('collectDatabaseId', () => {
  it('accepts a well-formed uuid, trimmed', () => {
    expect(collectDatabaseId({ D1_DATABASE_ID: ` ${ID} ` })).toEqual({ ok: true, id: ID });
    expect(collectDatabaseId({ D1_DATABASE_ID: ID.toUpperCase() })).toEqual({ ok: true, id: ID.toUpperCase() });
  });

  it('refuses when unset or blank, naming the variable', () => {
    for (const env of [{}, { D1_DATABASE_ID: '' }, { D1_DATABASE_ID: '   ' }]) {
      const result = collectDatabaseId(env);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.join(' ')).toContain('D1_DATABASE_ID');
    }
  });

  it('refuses a value that is not a uuid, naming the variable but not the value', () => {
    for (const bad of ['REPLACE_WITH_YOUR_D1_DATABASE_ID', 'not-a-uuid', '12345', `${ID}; DROP TABLE`]) {
      const result = collectDatabaseId({ D1_DATABASE_ID: bad });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.join(' ')).toContain('D1_DATABASE_ID');
        expect(result.errors.join(' ')).not.toContain(bad);
      }
    }
  });
});

describe('collectInstanceNames', () => {
  it('keeps the committed defaults when both variables are unset or blank', () => {
    const defaults = { ok: true, names: { workerName: 'ratatoskr', databaseName: 'ratatoskr' } };
    expect(collectInstanceNames({})).toEqual(defaults);
    expect(collectInstanceNames({ WORKER_NAME: '', D1_DATABASE_NAME: '   ' })).toEqual(defaults);
  });

  it('accepts valid names, trimmed', () => {
    expect(collectInstanceNames({ WORKER_NAME: ' ratatoskr-skyrim ', D1_DATABASE_NAME: 'Ratatoskr_Skyrim-2' })).toEqual({
      ok: true,
      names: { workerName: 'ratatoskr-skyrim', databaseName: 'Ratatoskr_Skyrim-2' },
    });
  });

  it('refuses names Cloudflare would reject or that could break out of the config, naming the variable but not the value', () => {
    const workers = ['Ratatoskr', 'rata_toskr', '-ratatoskr', 'ratatoskr-', 'a'.repeat(64), 'rata toskr', 'x"y', `x${String.fromCharCode(92)}y`];
    const databases = ['_db', 'a'.repeat(64), 'my db', 'x"y', 'db;DROP', '../db'];
    for (const bad of workers) {
      const result = collectInstanceNames({ WORKER_NAME: bad });
      expect(result.ok, bad).toBe(false);
      if (!result.ok) {
        expect(result.errors.join(' ')).toContain('WORKER_NAME');
        expect(result.errors.join(' ')).not.toContain(bad);
      }
    }
    for (const bad of databases) {
      const result = collectInstanceNames({ D1_DATABASE_NAME: bad });
      expect(result.ok, bad).toBe(false);
      if (!result.ok) expect(result.errors.join(' ')).toContain('D1_DATABASE_NAME');
    }
  });

  it('reports both variables when both are bad', () => {
    const result = collectInstanceNames({ WORKER_NAME: 'Bad Name', D1_DATABASE_NAME: 'bad name' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toHaveLength(2);
  });
});

describe('defaultDatabaseName', () => {
  it('is D1_DATABASE_NAME when set, else ratatoskr', () => {
    expect(defaultDatabaseName({})).toBe('ratatoskr');
    expect(defaultDatabaseName({ D1_DATABASE_NAME: '  ' })).toBe('ratatoskr');
    expect(defaultDatabaseName({ D1_DATABASE_NAME: ' my-db ' })).toBe('my-db');
  });
});

describe('buildDeployConfig names', () => {
  const FULL = [
    '{',
    '  "name": "ratatoskr",',
    '  "d1_databases": [{ "binding": "DB", "database_name": "ratatoskr", "database_id": "REPLACE_WITH_YOUR_D1_DATABASE_ID" }]',
    '}',
    '',
  ].join('\n');

  it('leaves both names alone for the defaults', () => {
    const result = buildDeployConfig(FULL, ID);
    expect(result).toEqual({ ok: true, text: FULL.replace('REPLACE_WITH_YOUR_D1_DATABASE_ID', ID) });
  });

  it('renames the Worker and the database, and only those fields', () => {
    const result = buildDeployConfig(FULL, ID, { workerName: 'ratatoskr-skyrim', databaseName: 'ratatoskr_skyrim' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toContain('"name": "ratatoskr-skyrim"');
      expect(result.text).toContain('"database_name": "ratatoskr_skyrim"');
      expect(result.text).toContain('"binding": "DB"');
      expect(result.text).toContain(ID);
    }
  });

  it('renames one and keeps the other', () => {
    const result = buildDeployConfig(FULL, ID, { workerName: 'second', databaseName: 'ratatoskr' });
    expect(result.ok && result.text.includes('"name": "second"') && result.text.includes('"database_name": "ratatoskr"')).toBe(true);
  });

  it('refuses to rename when the default text appears more than once, such as in a comment', () => {
    const commented = ['// e.g. "name": "ratatoskr"', FULL].join('\n');
    const result = buildDeployConfig(commented, ID, { workerName: 'second', databaseName: 'ratatoskr' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(' ')).toContain('found 2');
  });

  it('renames exactly the Worker and the database in the committed wrangler.jsonc', () => {
    const committed = readFileSync(join(import.meta.dirname, '../wrangler.jsonc'), 'utf8');
    const result = buildDeployConfig(committed, ID, { workerName: 'second-instance', databaseName: 'second_db' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text.match(/"name": "second-instance"/g)).toHaveLength(1);
    expect(result.text.match(/"database_name": "second_db"/g)).toHaveLength(1);
    const before = committed.split('\n').filter((line) => line.includes('"ratatoskr"')).length;
    expect(before).toBe(2);
    expect(result.text.split('\n').filter((line) => line.includes('"ratatoskr"'))).toHaveLength(0);
  });

  it('refuses to rename a field the committed config no longer carries at its default', () => {
    const edited = FULL.replace('"name": "ratatoskr"', '"name": "mine"');
    const result = buildDeployConfig(edited, ID, { workerName: 'second', databaseName: 'ratatoskr' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(' ')).toContain('"name"');
  });
});

describe('buildDeployConfig', () => {
  const CONFIG = '{\n  // comment\n  "database_id": "REPLACE_WITH_YOUR_D1_DATABASE_ID"\n}\n';

  it('substitutes the placeholder for the real id, keeping comments and formatting', () => {
    expect(buildDeployConfig(CONFIG, ID)).toEqual({ ok: true, text: `{\n  // comment\n  "database_id": "${ID}"\n}\n` });
  });

  it('refuses a config file without the expected placeholder', () => {
    const result = buildDeployConfig('{ "database_id": "already-set" }', ID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(' ')).toContain('wrangler.jsonc');
  });

  it('substitutes every occurrence of the placeholder, not just the first', () => {
    const twice = '{ "a": "REPLACE_WITH_YOUR_D1_DATABASE_ID", "b": "REPLACE_WITH_YOUR_D1_DATABASE_ID" }';
    const result = buildDeployConfig(twice, ID);
    expect(result).toEqual({ ok: true, text: `{ "a": "${ID}", "b": "${ID}" }` });
  });
});

describe('stripLeadingSeparator', () => {
  it('drops a leading bare -- (the pnpm-forwarded end-of-options marker)', () => {
    expect(stripLeadingSeparator(['--', '--dry-run'])).toEqual(['--dry-run']);
    expect(stripLeadingSeparator(['--'])).toEqual([]);
  });

  it('leaves other args untouched, including a later --', () => {
    expect(stripLeadingSeparator(['--dry-run'])).toEqual(['--dry-run']);
    expect(stripLeadingSeparator([])).toEqual([]);
    expect(stripLeadingSeparator(['d1', 'execute', '--', '--remote'])).toEqual(['d1', 'execute', '--', '--remote']);
  });
});

describe('withGeneratedConfig', () => {
  it('writes the text next to root, readable by use, then removes it', () => {
    let seenPath = '';
    const result = withGeneratedConfig(tmpdir(), '{ "hello": true }', (path) => {
      seenPath = path;
      expect(existsSync(path)).toBe(true);
      expect(path.startsWith(tmpdir())).toBe(true);
      expect(readFileSync(path, 'utf8')).toBe('{ "hello": true }');
      return 'done';
    });
    expect(result).toBe('done');
    expect(existsSync(seenPath)).toBe(false);
  });

  it('removes the file even when use throws', () => {
    let seenPath = '';
    expect(() =>
      withGeneratedConfig(tmpdir(), '{}', (path) => {
        seenPath = path;
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(existsSync(seenPath)).toBe(false);
  });
});
