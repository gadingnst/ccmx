import pc from 'picocolors';

/**
 * Info goes to stdout (some terminals paint all of stderr red); warnings and errors go to
 * stderr. Hook entry points never log: their stdout is JSON for claude.
 */
export const logger = {
  info(msg: string) {
    console.log(`${pc.dim('ccmx')} ${msg}`);
  },
  warn(msg: string) {
    console.error(`${pc.yellow('ccmx')} ${msg}`);
  },
  error(msg: string) {
    console.error(`${pc.red('ccmx')} ${msg}`);
  }
};
