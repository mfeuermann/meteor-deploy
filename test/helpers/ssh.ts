import ssh2 from 'ssh2';

/**
 * An ed25519 host key that ssh2 can read. ssh2's generateKeyPairSync now and then returns a key
 * its own parser rejects ("Malformed OpenSSH private key", about one in a hundred, with any
 * Node version), so such a key is replaced by a new one.
 */
export function hostKey(): string {
  for (let i = 0; i < 20; i++) {
    const key = ssh2.utils.generateKeyPairSync('ed25519').private;
    if (!(ssh2.utils.parseKey(key) instanceof Error)) return key;
  }
  throw new Error('ssh2 could not generate a readable ed25519 host key in 20 attempts');
}
