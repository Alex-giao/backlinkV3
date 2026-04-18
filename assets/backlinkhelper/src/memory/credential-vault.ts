import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

import {
  deleteCredentialRecord,
  loadCredentialRecord,
  saveCredentialRecord,
} from "./data-store.js";
import type { CredentialPayload, CredentialVaultRecord } from "../shared/types.js";

const VAULT_SECRET_ENV = "BACKLINER_VAULT_KEY";
const IV_LENGTH = 12;

function getVaultKey(): Buffer {
  const secret = process.env[VAULT_SECRET_ENV]?.trim();
  if (!secret) {
    throw new Error(`Missing required environment variable ${VAULT_SECRET_ENV} for the local credential vault.`);
  }

  return createHash("sha256").update(secret).digest();
}

function encryptPayload(payload: CredentialPayload): string {
  const key = getVaultKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString("base64");
}

function decryptPayload(encoded: string): CredentialPayload {
  const raw = Buffer.from(encoded, "base64");
  const iv = raw.subarray(0, IV_LENGTH);
  const authTag = raw.subarray(IV_LENGTH, IV_LENGTH + 16);
  const encrypted = raw.subarray(IV_LENGTH + 16);
  const decipher = createDecipheriv("aes-256-gcm", getVaultKey(), iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
  return JSON.parse(decrypted) as CredentialPayload;
}

export async function putCredential(
  credentialRef: string,
  payload: CredentialPayload,
): Promise<CredentialVaultRecord> {
  const existing = await loadCredentialRecord(credentialRef);
  const now = new Date().toISOString();
  const record: CredentialVaultRecord = {
    credential_ref: credentialRef,
    encrypted_payload: encryptPayload(payload),
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };
  await saveCredentialRecord(record);
  return record;
}

export async function getCredential(credentialRef: string): Promise<CredentialPayload | undefined> {
  const record = await loadCredentialRecord(credentialRef);
  if (!record) {
    return undefined;
  }

  return decryptPayload(record.encrypted_payload);
}

export async function deleteCredential(credentialRef: string): Promise<void> {
  await deleteCredentialRecord(credentialRef);
}
