// Preloaded into CLI tests (node --import): any network access is reported on stderr and fails.
const deny = (what) => () => {
  process.stderr.write(`NETWORK ACCESS ATTEMPTED: ${what}\n`);
  throw new Error('network disabled in test');
};
globalThis.fetch = deny('fetch');
