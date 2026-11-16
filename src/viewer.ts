// The viewer identity, fixed by the trial scenario (kit program/env/src/wire.ts, seed
// 0x6a09e667f3bcc909n). The shop token does not encode the viewer — the entry must know it
// from the scenario, so it is baked in here rather than derived from any credential.

export const VIEWER = {
  login: 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
  type: 'User',
} as const;

/** The scenario's other actors, for ownership checks (a repo under another login is a 404). */
export const SCENARIO_USERS = {
  teammate: { login: 'quinnkeller', id: 1001 },
  stranger: { login: 'olgabauer', id: 1002 },
  org: { login: 'faint-meadow-org', id: 2000 },
} as const;

/** The scenario's default labels, created with every new repository. */
export const DEFAULT_LABELS: readonly { name: string; color: string }[] = [
  { name: 'bug', color: 'd73a4a' },
  { name: 'enhancement', color: 'a2eeef' },
  { name: 'documentation', color: '0075ca' },
  { name: 'question', color: 'd876e3' },
  { name: 'good first issue', color: '7057ff' },
  { name: 'help wanted', color: '008672' },
];
