/**
 * Choosing the one server of `ssh` and `meteor debug` (commands design §4.1), and reading the
 * words typed after the command name.
 */
import { CometError } from '../core/errors.js';

/**
 * Picks the server from the first word, or the only candidate when there is one.
 *
 * - The first word is a candidate: that server; the other words are `rest`.
 * - No words: the only candidate, else `Choose a server: <usage>. Servers: …`.
 * - The first word is not a candidate: with `wordsMayBeCommand` and a single candidate, all
 *   words are `rest` (`ssh uptime`); otherwise `Unknown server "<word>". Servers: …`.
 *
 * @param o.candidates server names in config order, already filtered by `--servers`
 * @throws CometError as above
 */
export function pickServer(o: { words: string[]; candidates: string[]; usage: string; wordsMayBeCommand: boolean }): { server: string; rest: string[] } {
  const list = `Servers: ${o.candidates.join(', ')}`;
  const [first, ...rest] = o.words;
  if (first !== undefined && o.candidates.includes(first)) return { server: first, rest };
  if (o.candidates.length === 1 && (first === undefined || o.wordsMayBeCommand)) return { server: o.candidates[0], rest: o.words };
  if (first === undefined) throw new CometError(`Choose a server: ${o.usage}. ${list}`);
  throw new CometError(`Unknown server "${first}". ${list}`);
}

/**
 * The words typed after `commandName` (`ssh`, `meteor debug`): the command's `[words..]`
 * positional, then whatever followed `--` (yargs puts those into `argv._` after the command
 * name), in typed order. Numbers yargs parsed come back as the strings that were typed.
 */
export function commandWords(argv: Record<string, unknown>, commandName: string): string[] {
  const positional = ((argv.words as unknown[] | undefined) ?? []).map(String);
  const afterDashes = ((argv._ as unknown[] | undefined) ?? []).slice(commandName.split(' ').length).map(String);
  return [...positional, ...afterDashes];
}
