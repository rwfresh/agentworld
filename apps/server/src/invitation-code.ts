import { createHash, createHmac, randomBytes } from "node:crypto";

const INVITATION_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const INVITATION_RANDOM_BYTES = 24;
const INVITATION_GROUP_SIZE = 4;
/**
 * Fixed label for the reservation digest key. Deriving a dedicated key keeps the auth secret itself
 * out of the digest construction; changing the label invalidates every stored keyed digest.
 */
const RESERVATION_KEY_LABEL = "agentworld:invitation-reservation:v1";

type RandomBytes = (size: number) => Uint8Array;

/** The digests of one address as they may appear in `invitation_reservations.email_hash`. */
export interface EmailDigest {
  /** Keyed digest; every new reservation is written with this value. */
  readonly current: string;
  /** Every digest an unexpired row may carry for the address, the keyed digest first. */
  readonly accepted: readonly string[];
}

export type EmailDigester = (email: string) => EmailDigest;

export function normalizeEmail(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase();
}

export function normalizeInvitationCode(value: string): string {
  return value.normalize("NFKC").trim().toUpperCase();
}

export function invitationHash(code: string): string {
  return createHash("sha256").update(normalizeInvitationCode(code)).digest("hex");
}

/**
 * Reservation lookups key on a digest so the address itself never reaches durable storage. The
 * digest is HMAC-SHA-256 under a key derived from the auth secret, so a reader of the table cannot
 * confirm guessed addresses offline. Migration 007 backfilled live rows with the unkeyed SHA-256
 * digest and their plaintext is gone, so lookups also accept that digest until those rows expire
 * (within 24 hours); nothing writes it any more. Rotating the auth secret changes the key and
 * orphans reservations made under the previous secret for the rest of their window.
 */
export function createEmailDigester(authSecret: string): EmailDigester {
  const key = createHmac("sha256", authSecret).update(RESERVATION_KEY_LABEL).digest();
  return (email) => {
    const current = createHmac("sha256", key).update(normalizeEmail(email)).digest("hex");
    return { current, accepted: [current, legacyEmailHash(email)] };
  };
}

/** The unkeyed digest earlier releases stored. Lookup compatibility only: never write it. */
export function legacyEmailHash(email: string): string {
  return createHash("sha256").update(normalizeEmail(email)).digest("hex");
}

export function generateInvitationCode(random: RandomBytes = randomBytes): string {
  const bytes = random(INVITATION_RANDOM_BYTES);
  if (bytes.length !== INVITATION_RANDOM_BYTES) {
    throw new Error("Invitation randomness source returned an unexpected byte count");
  }

  const token = Array.from(
    bytes,
    (byte) => INVITATION_ALPHABET[byte & (INVITATION_ALPHABET.length - 1)],
  ).join("");
  const groups: string[] = [];
  for (let index = 0; index < token.length; index += INVITATION_GROUP_SIZE) {
    groups.push(token.slice(index, index + INVITATION_GROUP_SIZE));
  }
  return `AW-${groups.join("-")}`;
}
