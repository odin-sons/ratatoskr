// SPDX-License-Identifier: AGPL-3.0-or-later
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { diagramEditUrl, diagramImageUrl, encodeDiagram, xyChartCode } from './mermaid.ts';

const chart = {
  title: 'D1 usage, % of the daily free limit',
  yTitle: 'percent',
  yMax: 100,
  labels: ['10-01', '10-02'],
  series: [
    { kind: 'line' as const, values: [3.5, 3.9] },
    { kind: 'bar' as const, values: [70, 70] },
  ],
  colors: ['#4c9be8', '#e85d4c'],
};

interface EditorState {
  code: string;
  mermaid: string;
  autoSync: boolean;
  updateDiagram: boolean;
}

function decode(encoded: string): EditorState {
  expect(encoded.startsWith('pako:')).toBe(true);
  const base64 = encoded.slice(5).replaceAll('-', '+').replaceAll('_', '/');
  return JSON.parse(new TextDecoder().decode(inflateSync(Buffer.from(base64, 'base64')))) as EditorState;
}

describe('xyChartCode', () => {
  it('writes an xychart-beta diagram with the palette, axes and one line per series', () => {
    expect(xyChartCode(chart).split('\n')).toEqual([
      '%%{init: {"themeVariables": {"xyChart": {"plotColorPalette": "#4c9be8,#e85d4c"}}}}%%',
      'xychart-beta',
      '    title "D1 usage, % of the daily free limit"',
      '    x-axis ["10-01", "10-02"]',
      '    y-axis "percent" 0 --> 100',
      '    line [3.5, 3.9]',
      '    bar [70, 70]',
    ]);
  });

  it('cannot be broken out of its quotes by a title or label', () => {
    const code = xyChartCode({ ...chart, title: 'a"b', labels: ['x"y'] });
    expect(code).toContain('title "a\'b"');
    expect(code).toContain('x-axis ["x\'y"]');
  });
});

describe('encodeDiagram', () => {
  it('produces the pako form Mermaid Live and mermaid.ink read: the editor state in a zlib stream, base64url', () => {
    const code = xyChartCode(chart);
    const encoded = encodeDiagram(code);
    expect(encoded).toMatch(/^pako:[A-Za-z0-9_-]+$/);
    const state = decode(encoded);
    expect(state.code).toBe(code);
    expect(JSON.parse(state.mermaid)).toEqual({ theme: 'dark' });
    expect(state).toMatchObject({ autoSync: true, updateDiagram: true });
  });

  it('is deterministic', () => {
    const code = xyChartCode(chart);
    expect(encodeDiagram(code)).toBe(encodeDiagram(code));
  });

  it('survives a payload longer than one stored block, and an empty diagram', () => {
    const long = `${xyChartCode(chart)}\n${'x'.repeat(150_000)}`;
    expect(decode(encodeDiagram(long)).code).toBe(long);
    expect(decode(encodeDiagram('')).code).toBe('');
  });

  it('encodes non-ASCII text', () => {
    const text = 'title "caf\u00e9 \u65e5\u672c\u8a9e"';
    expect(decode(encodeDiagram(text)).code).toBe(text);
  });

  it('keeps the whole URL short enough for a Discord embed image', () => {
    const labels = Array.from({ length: 7 }, (_, i) => `10-0${i + 1}`);
    const code = xyChartCode({ ...chart, labels, series: [{ kind: 'line', values: labels.map(() => 12.3) }, { kind: 'line', values: labels.map(() => 70) }] });
    expect(diagramImageUrl(encodeDiagram(code)).length).toBeLessThan(2000);
  });
});

describe('diagram URLs', () => {
  it('point at mermaid.ink for the image and mermaid.live for the editor', () => {
    expect(diagramImageUrl('pako:abc')).toBe('https://mermaid.ink/img/pako:abc?type=png&theme=dark');
    expect(diagramEditUrl('pako:abc')).toBe('https://mermaid.live/edit#pako:abc');
  });
});
