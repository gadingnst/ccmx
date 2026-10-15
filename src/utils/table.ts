// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes is the point
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
const width = (s: string) => [...plain(s)].length;

/** Left-aligned columns; ANSI colour codes do not count towards the width. */
export function formatTable(rows: string[][]): string {
  const widths = rows.at(0)!.map((_, c) => Math.max(...rows.map((r) => width(r.at(c) ?? ''))));
  return rows
    .map((r) =>
      r
        .map((cell, c) => cell + ' '.repeat(widths.at(c)! - width(cell)))
        .join('  ')
        .trimEnd()
    )
    .join('\n');
}
