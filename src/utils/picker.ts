import pc from 'picocolors';

export type PickerItem<T> = { value: T; columns: string[]; search: string };

export type PickerOptions = {
  title: string;
  /** Shown under the list, e.g. which profile a choice opens on. */
  footer?: string;
};

const KEY = {
  up: ['\x1b[A', '\x1bOA', '\x10'],
  down: ['\x1b[B', '\x1bOB', '\x0e'],
  pageUp: ['\x1b[5~'],
  pageDown: ['\x1b[6~'],
  enter: ['\r', '\n'],
  cancel: ['\x03', '\x1b'],
  backspace: ['\x7f', '\b']
};

/** A lone ESC is the Esc key only if nothing follows it this quickly. */
const ESC_WAIT_MS = 50;

/**
 * Modes a previous program (often claude itself, if it was killed) may have left on. Their
 * reports — mouse clicks, focus changes, paste brackets — would otherwise arrive as input.
 */
const QUIET_INPUT = '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1015l\x1b[?1004l\x1b[?2004l';

// CSI is ESC [ then parameter bytes 0x30-0x3F (digits ; < = > ?), intermediates, a final.
// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape sequences
const SEQUENCE = /^\x1b(?:\[[0-?]*[ -/]*[@-~]|O[@-~])/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape sequences
const PARTIAL = /^\x1b(?:\[[0-?]*[ -/]*|O)$/;

/**
 * Split raw input into keys. Terminals send an arrow as several bytes that can arrive in
 * separate chunks, and several keys can arrive in one, so input is buffered and cut at
 * key boundaries. Returns the keys plus whatever is still incomplete.
 */
export function splitKeys(input: string): { keys: string[]; rest: string } {
  const keys: string[] = [];
  let s = input;
  while (s) {
    if (s.startsWith('\x1b')) {
      const m = s.match(SEQUENCE);
      if (m) {
        keys.push(m[0]);
        s = s.slice(m[0].length);
        continue;
      }
      // "\x1b" or "\x1b[" with the rest still on its way.
      if (PARTIAL.test(s) || s === '\x1b') break;
      // ESC followed by a character is Alt/Option+key (Option+Backspace, Alt+b): one key,
      // never the Esc that cancels.
      const alt = [...s.slice(1)][0]!;
      keys.push(`\x1b${alt}`);
      s = s.slice(1 + alt.length);
      continue;
    }
    const ch = [...s][0]!;
    keys.push(ch);
    s = s.slice(ch.length);
  }
  return { keys, rest: s };
}

/** Columns a string takes on screen: emoji and CJK count two, colour codes none. */
const width = (s: string) => Bun.stringWidth(s);

/** Pad or cut to exactly `w` columns, so no line ever wraps and breaks the redraw. */
export function fit(s: string, w: number): string {
  if (w <= 0) return '';
  if (width(s) <= w) return s + ' '.repeat(w - width(s));
  let out = '';
  for (const ch of s) {
    if (width(out + ch) > w - 1) break;
    out += ch;
  }
  return `${out}…${' '.repeat(Math.max(0, w - 1 - width(out)))}`;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: colour codes
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

/**
 * Arrow-key list picker on the terminal: ↑/↓ to move, Enter to choose, typing
 * filters, Esc or Ctrl+C cancels. Draws on stdout with explicit colours, because some
 * terminals paint stderr red.
 */
export async function pick<T>(items: PickerItem<T>[], opts: PickerOptions): Promise<T | undefined> {
  const out = process.stdout;
  const stdin = process.stdin;
  let filter = '';
  let cursor = 0;
  let top = 0;
  let drawn = 0;

  const visible = () => {
    const q = filter.toLowerCase();
    return q ? items.filter((i) => i.search.toLowerCase().includes(q)) : items;
  };
  const widths = items.length
    ? items[0]!.columns.map((_, c) => Math.max(...items.map((i) => width(i.columns[c] ?? ''))))
    : [];

  const draw = () => {
    const list = visible();
    const rows = Math.max(3, Math.min(15, (out.rows || 24) - 6));
    cursor = Math.min(cursor, Math.max(0, list.length - 1));
    if (cursor < top) top = cursor;
    if (cursor >= top + rows) top = cursor - rows + 1;
    // One column spare: writing into the last column makes some terminals wrap.
    const cols = Math.max(20, (out.columns || 100) - 1);
    const lines: string[] = [];
    const hint = '↑/↓ move · enter open · type to filter · esc cancel';
    const head = fit(`${opts.title}  ${hint}`, cols).trimEnd();
    lines.push(
      head.startsWith(`${opts.title}  `)
        ? `${pc.bold(opts.title)}  ${pc.dim(head.slice(opts.title.length + 2))}`
        : pc.bold(head)
    );
    lines.push(`${pc.dim('filter:')} ${fit(filter, cols - 9).trimEnd()}${pc.inverse(' ')}`);
    if (!list.length) lines.push(pc.dim('  no match'));
    for (let i = top; i < Math.min(list.length, top + rows); i++) {
      const item = list[i]!;
      const fixed = item.columns.slice(0, -1).map((c, k) => fit(c, widths[k]!));
      const used = fixed.reduce((n, c) => n + width(c) + 2, 2);
      const last = fit(item.columns.at(-1) ?? '', Math.max(1, cols - used)).trimEnd();
      lines.push(
        i === cursor
          ? `${pc.greenBright('❯')} ${pc.bold(pc.greenBright([...fixed, last].join('  ')))}`
          : `  ${pc.gray(fixed.join('  '))}  ${last}`
      );
    }
    if (list.length > rows) lines.push(pc.dim(`  ${cursor + 1}/${list.length}`));
    if (opts.footer) {
      lines.push(
        width(opts.footer) <= cols ? opts.footer : fit(plain(opts.footer), cols).trimEnd()
      );
    }
    // Back to the first line drawn last time, clear below, draw again.
    out.write(`${drawn ? `\x1b[${drawn}F` : ''}\x1b[0J\x1b[0m${lines.join('\n')}\n`);
    drawn = lines.length;
  };

  return new Promise((resolve) => {
    const decoder = new TextDecoder();
    let pending = '';
    let escTimer: ReturnType<typeof setTimeout> | undefined;
    let finished = false;

    const restore = () => {
      stdin.setRawMode(false);
      out.write(`\x1b[${drawn}F\x1b[0J\x1b[?25h`);
    };
    // Killed while picking: give the terminal back before going.
    const onKill = (sig: NodeJS.Signals) => {
      restore();
      process.exit(sig === 'SIGTERM' ? 143 : 129);
    };
    const done = (value: T | undefined) => {
      finished = true;
      if (escTimer) clearTimeout(escTimer);
      stdin.off('data', onData);
      out.off('resize', draw);
      process.off('SIGTERM', onKill);
      process.off('SIGHUP', onKill);
      restore();
      stdin.pause();
      resolve(value);
    };
    /** Apply one key; true when the picker is done. */
    const handle = (k: string): boolean => {
      const list = visible();
      if (KEY.cancel.includes(k)) {
        done(undefined);
        return true;
      }
      if (KEY.enter.includes(k)) {
        done(list[cursor]?.value);
        return true;
      }
      if (KEY.up.includes(k)) cursor = Math.max(0, cursor - 1);
      else if (KEY.down.includes(k)) cursor = Math.min(list.length - 1, cursor + 1);
      else if (KEY.pageUp.includes(k)) cursor = Math.max(0, cursor - 10);
      else if (KEY.pageDown.includes(k)) cursor = Math.min(list.length - 1, cursor + 10);
      else if (KEY.backspace.includes(k)) filter = [...filter].slice(0, -1).join('');
      else if (!k.startsWith('\x1b') && k >= ' ') {
        filter += k;
        cursor = 0;
      }
      return false;
    };
    function onData(buf: Buffer) {
      if (escTimer) clearTimeout(escTimer);
      // stream: a multi-byte character split across reads is kept until it is whole.
      const { keys, rest } = splitKeys(pending + decoder.decode(buf, { stream: true }));
      pending = rest;
      for (const k of keys) if (handle(k)) return;
      draw();
      if (pending) {
        // Nothing completed the sequence: a lone ESC is Esc, any other fragment is noise.
        escTimer = setTimeout(() => {
          const lone = pending === '\x1b';
          pending = '';
          if (!finished && lone) handle('\x1b');
        }, ESC_WAIT_MS);
      }
    }
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
    process.on('SIGTERM', onKill);
    process.on('SIGHUP', onKill);
    out.on('resize', draw);
    out.write(`${QUIET_INPUT}\x1b[?25l`);
    draw();
  });
}
