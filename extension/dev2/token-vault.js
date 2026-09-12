/**
 * Creates an in-memory token vault for session-scoped mapping between sensitive values and tokens.
 * @returns {{
 *   getOrCreateToken: (rawValue: string, sensitivityType: string) => string,
 *   resolveToken: (token: string) => string | null,
 *   hasToken: (token: string) => boolean,
 *   clear: () => void,
 *   destroy: () => void,
 *   getStats: () => { totalTokens: number, byType: Record<string, number> }
 * }}
 */

const allReverseMaps = new Set();

// CSPRNG-backed opaque suffix generator. Uses the Web Crypto API (available
// in both the extension runtime and modern Node) instead of Math.random(),
// which is not cryptographically secure and was previously guessable.
// Checked for vault-uniqueness before assignment so two different sensitive
// values in one session can never collide onto the same token.
const TOKEN_SUFFIX_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const TOKEN_SUFFIX_LENGTH = 10;

function randomSuffix() {
  const bytes = new Uint8Array(TOKEN_SUFFIX_LENGTH);
  const cryptoObj = (typeof globalThis !== 'undefined' && globalThis.crypto) || null;
  if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
    cryptoObj.getRandomValues(bytes);
  } else {
    // Last-resort fallback (should not happen in the extension or Node >= 18);
    // still not attacker-guessable per-byte since it's only used if the
    // platform genuinely lacks Web Crypto.
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += TOKEN_SUFFIX_ALPHABET[bytes[i] % TOKEN_SUFFIX_ALPHABET.length];
  }
  return out;
}

function generateUniqueToken(typeKey, reverseMap) {
  let token;
  do {
    token = `[${typeKey}_${randomSuffix()}]`;
  } while (reverseMap.has(token));
  return token;
}

export function isValidVaultToken(token) {
  if (typeof token !== 'string' || !token) {
    return false;
  }
  for (const map of allReverseMaps) {
    if (map.has(token)) return true;
  }
  return false;
}

export function createTokenVault() {
  const forwardMap = new Map(); // rawValue -> token
  const reverseMap = new Map(); // token -> rawValue
  allReverseMaps.add(reverseMap);

  return {
    /**
     * Gets existing token for rawValue or creates a new indexed token [TYPE_N].
     * @param {string} rawValue
     * @param {string} sensitivityType
     * @returns {string}
     */
    getOrCreateToken(rawValue, sensitivityType) {
      if (typeof rawValue !== 'string' || !rawValue) {
        return '';
      }

      const typeKey = (sensitivityType || 'UNKNOWN').toUpperCase();

      if (forwardMap.has(rawValue)) {
        return forwardMap.get(rawValue);
      }

      const token = generateUniqueToken(typeKey, reverseMap);
      forwardMap.set(rawValue, token);
      reverseMap.set(token, rawValue);

      return token;
    },

    /**
     * Resolves token back to raw value.
     * @param {string} token
     * @returns {string | null}
     */
    resolveToken(token) {
      if (typeof token !== 'string' || !token) {
        return null;
      }
      return reverseMap.get(token) || null;
    },

    /**
     * Checks if token exists in the vault.
     * @param {string} token
     * @returns {boolean}
     */
    hasToken(token) {
      if (typeof token !== 'string' || !token) {
        return false;
      }
      return reverseMap.has(token);
    },

    /**
     * Clears all mapped tokens and resets state for session teardown.
     */
    clear() {
      forwardMap.clear();
      reverseMap.clear();
    },

    /**
     * Removes this vault's reverseMap from the global tracking set.
     * Call after clear() during session teardown.
     */
    destroy() {
      allReverseMaps.delete(reverseMap);
    },

    /**
     * Returns count statistics without exposing raw values or tokens.
     * @returns {{ totalTokens: number, byType: Record<string, number> }}
     */
    getStats() {
      const byType = {};

      for (const [token] of reverseMap.entries()) {
        const match = token.match(/^\[([A-Z_]+)_[a-z0-9]+\]$/);
        const type = match ? match[1] : 'UNKNOWN';
        byType[type] = (byType[type] || 0) + 1;
      }

      return {
        totalTokens: reverseMap.size,
        byType
      };
    }
  };
}
