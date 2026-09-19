// SPDX-License-Identifier: AGPL-3.0-or-later
import { DatabaseSync } from 'node:sqlite';

type Bindable = string | number | null;

interface ShimMeta {
  changes: number;
  last_row_id: number;
  rows_read: number;
  rows_written: number;
  duration: number;
}

function normalise(value: unknown): Bindable {
  if (value === null || typeof value === 'string' || typeof value === 'number') return value;
  throw new Error(`D1_TYPE_ERROR: type '${value === undefined ? 'undefined' : typeof value}' not supported`);
}

/** Minimal D1Database over node:sqlite for tests. `batch` is transactional. */
export class D1Shim {
  readonly db = new DatabaseSync(':memory:');
  readonly preparedSql: string[] = [];
  readonly batchSizes: number[] = [];
  failWhen: ((sql: string) => boolean) | null = null;

  prepare(sql: string): ShimStatement {
    this.preparedSql.push(sql);
    return new ShimStatement(this, sql, []);
  }

  async batch<T = Record<string, unknown>>(statements: ShimStatement[]): Promise<D1Result<T>[]> {
    this.batchSizes.push(statements.length);
    this.db.exec('BEGIN');
    try {
      const results = statements.map((s) => s.execute<T>());
      this.db.exec('COMMIT');
      return results;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  async exec(sql: string): Promise<D1ExecResult> {
    this.db.exec(sql);
    return { count: 1, duration: 0 };
  }

  asD1(): D1Database {
    return this as unknown as D1Database;
  }
}

export class ShimStatement {
  private readonly shim: D1Shim;
  private readonly sql: string;
  private readonly params: Bindable[];

  constructor(shim: D1Shim, sql: string, params: Bindable[]) {
    this.shim = shim;
    this.sql = sql;
    this.params = params;
  }

  bind(...values: unknown[]): ShimStatement {
    return new ShimStatement(this.shim, this.sql, values.map(normalise));
  }

  execute<T>(): D1Result<T> {
    if (this.shim.failWhen?.(this.sql)) throw new Error('D1_ERROR: injected failure');
    const stmt = this.shim.db.prepare(this.sql);
    if (stmt.columns().length > 0) {
      const rows = stmt.all(...this.params).map((r) => ({ ...r })) as T[];
      return { success: true, results: rows, meta: meta(0, rows.length) } as unknown as D1Result<T>;
    }
    const { changes, lastInsertRowid } = stmt.run(...this.params);
    return {
      success: true,
      results: [],
      meta: { ...meta(Number(changes), 0), last_row_id: Number(lastInsertRowid) },
    } as unknown as D1Result<T>;
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return this.execute<T>();
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return this.execute<T>();
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    return this.execute<T>().results[0] ?? null;
  }
}

function meta(changes: number, rowsRead: number): ShimMeta {
  return { changes, last_row_id: 0, rows_read: rowsRead, rows_written: changes, duration: 0 };
}
