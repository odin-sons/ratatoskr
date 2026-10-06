// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Interaction } from './types.ts';

type OptionValue = string | number | boolean;

export interface CommandOptions {
  string(name: string): string | undefined;
  integer(name: string): number | undefined;
  boolean(name: string): boolean | undefined;
  /** The option the user is typing in an autocomplete request. */
  focused: { name: string; value: string } | undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Reads the top-level options of a command payload; a value of another type than asked for counts as absent. */
export function parseOptions(interaction: Interaction): CommandOptions {
  const values = new Map<string, OptionValue>();
  let focused: CommandOptions['focused'];
  for (const raw of interaction.data?.options ?? []) {
    if (!isRecord(raw) || typeof raw.name !== 'string') continue;
    const value = raw.value;
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') continue;
    values.set(raw.name, value);
    if (raw.focused === true) focused = { name: raw.name, value: typeof value === 'string' ? value : String(value) };
  }
  return {
    string: (name) => {
      const value = values.get(name);
      return typeof value === 'string' ? value : undefined;
    },
    integer: (name) => {
      const value = values.get(name);
      return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
    },
    boolean: (name) => {
      const value = values.get(name);
      return typeof value === 'boolean' ? value : undefined;
    },
    focused,
  };
}
