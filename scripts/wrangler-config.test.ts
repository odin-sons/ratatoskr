// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { buildDeployConfig, collectDatabaseId, stripLeadingSeparator, withGeneratedConfig } from './wrangler-config.ts';

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
