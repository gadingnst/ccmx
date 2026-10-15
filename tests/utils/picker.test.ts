import { describe, expect, it } from 'bun:test';
import { fit, splitKeys } from '@/utils/picker';

describe('splitKeys', () => {
  it('reads an arrow as one key', () => {
    expect(splitKeys('\x1b[B')).toEqual({ keys: ['\x1b[B'], rest: '' });
  });

  it('waits for the rest of an arrow split across chunks instead of calling it Esc', () => {
    expect(splitKeys('\x1b')).toEqual({ keys: [], rest: '\x1b' });
    expect(splitKeys('\x1b[')).toEqual({ keys: [], rest: '\x1b[' });
    expect(splitKeys('\x1b' + '[A')).toEqual({ keys: ['\x1b[A'], rest: '' });
  });

  it('splits several keys arriving together', () => {
    expect(splitKeys('\x1b[B\x1b[Bab\r').keys).toEqual(['\x1b[B', '\x1b[B', 'a', 'b', '\r']);
  });

  it('passes focus and page keys through as single sequences', () => {
    expect(splitKeys('\x1b[I\x1b[6~').keys).toEqual(['\x1b[I', '\x1b[6~']);
  });
});

describe('splitKeys with leftover terminal modes', () => {
  it('reads SGR mouse and focus reports as whole sequences, never as Esc', () => {
    expect(splitKeys('\x1b[<0;12;5M\x1b[<0;12;5m\x1b[O').keys).toEqual([
      '\x1b[<0;12;5M',
      '\x1b[<0;12;5m',
      '\x1b[O'
    ]);
    expect(splitKeys('\x1b[<0;1').rest).toBe('\x1b[<0;1');
  });
});

describe('fit', () => {
  it('measures emoji and CJK as two columns so lines never wrap', () => {
    const s = fit('ok 😀 中文 title', 8);
    expect(Bun.stringWidth(s)).toBe(8);
    expect(Bun.stringWidth(fit('short', 10))).toBe(10);
  });
});

describe('splitKeys with Alt/Option', () => {
  it('reads ESC + key as one Alt key, so Option+Backspace never cancels', () => {
    expect(splitKeys('\x1b\x7f').keys).toEqual(['\x1b\x7f']);
    expect(splitKeys('\x1bbx').keys).toEqual(['\x1bb', 'x']);
  });
});
