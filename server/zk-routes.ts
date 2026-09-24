/**
 * Everything a zero-knowledge-only server will answer. Identity, health, the
 * mode probe, the encrypted-blob courier with its kept versions, its
 * membership list and invitations (emails the server already knows from IAP),
 * and the daily price basket with its monthly market history (one file,
 * identical for every caller) — nothing that carries plaintext in either
 * direction. The list is the whole
 * privacy claim for scarab.one, so it is deliberately short and literal.
 *
 * Each entry is a regex fragment matched against the whole path after /api/.
 * Every route not listed here is plaintext-only and gets a 403 on a vault-only
 * server. Each stream appends to its own section only, so parallel additions
 * never touch the same lines. Adding a pattern is a privacy decision: say in
 * PRIVACY.md what the new route lets the server see.
 */
const PATTERNS = [
  // — core (foundation) —
  'me', 'health', 'mode', 'vault', 'vault/members', 'vault/members/[^/]+', 'basket', 'basket/status', 'basket/rebuild',
  // — zk stream (Z) — append below
  'vault/history', 'vault/history/[0-9]+', // the household's kept ciphertext versions: metadata, and one blob (PRIVACY.md)
  'vault/invites/accept', 'vault/invites/[^/]+', // accepting or declining an invitation into a household: routing only (PRIVACY.md)
  // — analytics stream (A) — append below
  'basket/history', // the monthly market history: one file, identical for every caller (PRIVACY.md)
]

export const ZK_ROUTES = new RegExp(`^/api/(${PATTERNS.join('|')})$`)
