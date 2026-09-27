// SPDX-License-Identifier: AGPL-3.0-or-later

/** Code points that render as nothing (or reorder text) and must never reach Discord, by class. */
export const INVISIBLE_CODE_POINTS: Array<[string, number]> = [
  ['soft hyphen', 0xad],
  ['combining grapheme joiner', 0x34f],
  ['arabic letter mark', 0x61c],
  ['hangul choseong filler', 0x115f],
  ['hangul jungseong filler', 0x1160],
  ['mongolian free variation selector', 0x180b],
  ['mongolian vowel separator', 0x180e],
  ['zero-width space', 0x200b],
  ['zero-width non-joiner', 0x200c],
  ['left-to-right mark', 0x200e],
  ['right-to-left mark', 0x200f],
  ['line separator', 0x2028],
  ['paragraph separator', 0x2029],
  ['bidi embedding', 0x202a],
  ['bidi override', 0x202e],
  ['word joiner', 0x2060],
  ['invisible times', 0x2062],
  ['invisible plus', 0x2064],
  ['unassigned format character', 0x2065],
  ['bidi isolate', 0x2066],
  ['bidi isolate end', 0x2069],
  ['deprecated format character', 0x206a],
  ['deprecated format character', 0x206f],
  ['braille blank', 0x2800],
  ['hangul filler', 0x3164],
  ['variation selector 1', 0xfe00],
  ['variation selector 16', 0xfe0f],
  ['byte order mark', 0xfeff],
  ['halfwidth hangul filler', 0xffa0],
  ['interlinear annotation anchor', 0xfff9],
  ['interlinear annotation terminator', 0xfffb],
  ['noncharacter FFFE', 0xfffe],
  ['noncharacter FFFF', 0xffff],
  ['tag space', 0xe0020],
  ['tag latin a', 0xe0041],
  ['language tag', 0xe0001],
  ['tag null', 0xe0000],
  ['cancel tag', 0xe007f],
  ['variation selector 17', 0xe0100],
  ['variation selector 256', 0xe01ef],
  ['C0 control', 0x7],
  ['C1 control', 0x85],
];

export const INVISIBLE_PATTERN = new RegExp(
  // eslint-disable-next-line no-misleading-character-class -- combined ranges detect invisible/steganographic characters
  '[\\p{Cc}\\p{Bidi_Control}\\u00AD\\u034F\\u115F\\u1160\\u180B-\\u180E\\u200B-\\u200F\\u2028\\u2029\\u2060-\\u206F\\u2800\\u3164\\uFE00-\\uFE0F\\uFEFF\\uFFA0\\uFFF9-\\uFFFB\\uFFFE\\uFFFF\\u{E0000}-\\u{E007F}\\u{E0100}-\\u{E01EF}]',
  'u',
);

/** True when `text` holds an invisible or control character other than tab and newline. */
export const hasInvisible = (text: string): boolean => INVISIBLE_PATTERN.test(text.replace(/[\t\n]/g, ''));
