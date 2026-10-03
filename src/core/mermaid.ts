// SPDX-License-Identifier: AGPL-3.0-or-later

export interface ChartSeries {
  kind: 'bar' | 'line';
  values: number[];
}

export interface XyChart {
  title: string;
  yTitle: string;
  yMax: number;
  labels: string[];
  series: ChartSeries[];
  /** One colour per series, in series order. */
  colors: string[];
}

/** An `xychart-beta` diagram. Labels and the title are quoted, with double quotes removed from them. */
export function xyChartCode(chart: XyChart): string {
  const quote = (text: string): string => `"${text.replaceAll('"', "'")}"`;
  const palette = chart.colors.join(',');
  return [
    `%%{init: {"themeVariables": {"xyChart": {"plotColorPalette": "${palette}"}}}}%%`,
    'xychart-beta',
    `    title ${quote(chart.title)}`,
    `    x-axis [${chart.labels.map(quote).join(', ')}]`,
    `    y-axis ${quote(chart.yTitle)} 0 --> ${chart.yMax}`,
    ...chart.series.map((s) => `    ${s.kind} [${s.values.join(', ')}]`),
  ].join('\n');
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export const MERMAID_INK_URL = 'https://mermaid.ink';
export const MERMAID_LIVE_URL = 'https://mermaid.live';

const STORED_BLOCK_MAX = 0xffff;

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (const byte of bytes) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** A zlib stream of stored (uncompressed) deflate blocks: any inflater reads it, and it costs no CPU worth measuring. */
function zlibStored(bytes: Uint8Array): Uint8Array {
  const blocks = Math.max(1, Math.ceil(bytes.length / STORED_BLOCK_MAX));
  const out = new Uint8Array(2 + bytes.length + blocks * 5 + 4);
  out.set([0x78, 0x01]);
  let at = 2;
  for (let i = 0; i < blocks; i += 1) {
    const chunk = bytes.subarray(i * STORED_BLOCK_MAX, (i + 1) * STORED_BLOCK_MAX);
    const length = chunk.length;
    out.set([i === blocks - 1 ? 1 : 0, length & 0xff, length >> 8, ~length & 0xff, (~length >> 8) & 0xff], at);
    out.set(chunk, at + 5);
    at += 5 + length;
  }
  new DataView(out.buffer).setUint32(at, adler32(bytes));
  return out;
}

/** The `pako:` form Mermaid Live and mermaid.ink read: the editor state as JSON in a zlib stream, base64url. */
export function encodeDiagram(code: string): string {
  const state = JSON.stringify({ code, mermaid: JSON.stringify({ theme: 'dark' }), autoSync: true, updateDiagram: true });
  return `pako:${toBase64Url(zlibStored(new TextEncoder().encode(state)))}`;
}

/** A PNG rendered by mermaid.ink, fetched by whoever shows the message, not by the bot. */
export const diagramImageUrl = (encoded: string): string => `${MERMAID_INK_URL}/img/${encoded}?type=png&theme=dark`;

/** Opens the diagram in the Mermaid Live editor. */
export const diagramEditUrl = (encoded: string): string => `${MERMAID_LIVE_URL}/edit#${encoded}`;
