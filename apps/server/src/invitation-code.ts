import { createHash, randomBytes } from "node:crypto";

const INVITATION_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const INVITATION_RANDOM_BYTES = 24;
const INVITATION_GROUP_SIZE = 4;

type RandomBytes = (size: number) => Uint8Array;

export function normalizeEmail(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase();
}

export function normalizeInvitationCode(value: string): string {
  return value.normalize("NFKC").trim().toUpperCase();
}

export function invitationHash(code: string): string {
  return createHash("sha256").update(normalizeInvitationCode(code)).digest("hex");
}

/** Reservation lookups key on this digest so the address itself never reaches durable storage. */
export function emailHash(email: string): string {
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
