import { type Kysely, sql } from "kysely";

// Generated from Better Auth 1.7.2 with JWT, magic-link, OAuth Provider, and
// OAuth Device Authorization enabled. Keep this migration in lockstep with
// apps/server/src/auth.ts when auth plugins change.
const statements = [
  `create schema if not exists auth`,
  `create table auth."user" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" boolean not null, "image" text, "createdAt" timestamptz default current_timestamp not null, "updatedAt" timestamptz default current_timestamp not null)`,
  `create table auth."session" ("id" text not null primary key, "expiresAt" timestamptz not null, "token" text not null unique, "createdAt" timestamptz default current_timestamp not null, "updatedAt" timestamptz not null, "ipAddress" text, "userAgent" text, "userId" text not null references auth."user" ("id") on delete cascade)`,
  `create table auth."account" ("id" text not null primary key, "issuer" text not null, "accountId" text not null, "providerId" text not null, "userId" text not null references auth."user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" timestamptz, "refreshTokenExpiresAt" timestamptz, "scope" text, "password" text, "createdAt" timestamptz default current_timestamp not null, "updatedAt" timestamptz not null)`,
  `create table auth."verification" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" timestamptz not null, "createdAt" timestamptz default current_timestamp not null, "updatedAt" timestamptz default current_timestamp not null)`,
  `create table auth."jwks" ("id" text not null primary key, "publicKey" text not null, "privateKey" text not null, "createdAt" timestamptz not null, "expiresAt" timestamptz, "alg" text, "crv" text)`,
  `create table auth."oauthClient" ("id" text not null primary key, "clientId" text not null unique, "clientSecret" text, "clientDiscoveryId" text, "disabled" boolean, "skipConsent" boolean, "enableEndSession" boolean, "subjectType" text, "scopes" jsonb, "clientCredentialsScopes" jsonb, "userId" text references auth."user" ("id") on delete cascade, "createdAt" timestamptz, "updatedAt" timestamptz, "name" text, "uri" text, "icon" text, "contacts" jsonb, "tos" text, "policy" text, "softwareId" text, "softwareVersion" text, "softwareStatement" text, "redirectUris" jsonb not null, "postLogoutRedirectUris" jsonb, "backchannelLogoutUri" text, "backchannelLogoutSessionRequired" boolean, "tokenEndpointAuthMethod" text, "applicationType" text, "jwks" text, "jwksUri" text, "grantTypes" jsonb, "responseTypes" jsonb, "requirePKCE" boolean, "dpopBoundAccessTokens" boolean, "referenceId" text, "metadata" jsonb)`,
  `create table auth."oauthResource" ("id" text not null primary key, "identifier" text not null unique, "name" text not null, "accessTokenTtl" integer, "refreshTokenTtl" integer, "signingAlgorithm" text, "signingKeyId" text, "allowedScopes" jsonb, "customClaims" jsonb, "dpopBoundAccessTokensRequired" boolean, "disabled" boolean, "createdAt" timestamptz, "updatedAt" timestamptz, "policyVersion" integer, "metadata" jsonb)`,
  `create table auth."oauthClientResource" ("id" text not null primary key, "clientId" text not null references auth."oauthClient" ("clientId") on delete cascade, "resourceId" text not null references auth."oauthResource" ("identifier") on delete cascade, "metadata" jsonb, "createdAt" timestamptz)`,
  `create table auth."oauthRefreshToken" ("id" text not null primary key, "token" text not null unique, "clientId" text not null references auth."oauthClient" ("clientId") on delete cascade, "sessionId" text references auth."session" ("id") on delete set null, "userId" text not null references auth."user" ("id") on delete cascade, "referenceId" text, "authorizationCodeId" text, "resources" jsonb, "requestedUserInfoClaims" jsonb, "expiresAt" timestamptz not null, "createdAt" timestamptz not null, "revoked" timestamptz, "rotatedAt" timestamptz, "rotationReplayResponse" text, "rotationReplayExpiresAt" timestamptz, "authTime" timestamptz, "confirmation" jsonb, "scopes" jsonb not null)`,
  `create table auth."oauthAccessToken" ("id" text not null primary key, "token" text not null unique, "clientId" text not null references auth."oauthClient" ("clientId") on delete cascade, "sessionId" text references auth."session" ("id") on delete set null, "userId" text references auth."user" ("id") on delete cascade, "referenceId" text, "authorizationCodeId" text, "resources" jsonb, "requestedUserInfoClaims" jsonb, "refreshId" text references auth."oauthRefreshToken" ("id") on delete cascade, "expiresAt" timestamptz not null, "createdAt" timestamptz not null, "revoked" timestamptz, "confirmation" jsonb, "scopes" jsonb not null)`,
  `create table auth."oauthConsent" ("id" text not null primary key, "clientId" text not null references auth."oauthClient" ("clientId") on delete cascade, "userId" text references auth."user" ("id") on delete cascade, "referenceId" text, "resources" jsonb, "requestedUserInfoClaims" jsonb, "scopes" jsonb not null, "createdAt" timestamptz not null, "updatedAt" timestamptz not null)`,
  `create table auth."oauthClientAssertion" ("id" text not null primary key, "expiresAt" timestamptz not null)`,
  `create table auth."deviceCode" ("id" text not null primary key, "deviceCode" text not null, "userCode" text not null, "userId" text, "expiresAt" timestamptz not null, "status" text not null, "lastPolledAt" timestamptz, "pollingInterval" integer, "clientId" text, "scope" text, "resources" jsonb, "oauthClientId" text)`,
  `create index "session_userId_idx" on auth."session" ("userId")`,
  `create index "account_userId_idx" on auth."account" ("userId")`,
  `create index "verification_identifier_idx" on auth."verification" ("identifier")`,
  `create index "oauthClient_userId_idx" on auth."oauthClient" ("userId")`,
  `create index "oauthClientResource_clientId_idx" on auth."oauthClientResource" ("clientId")`,
  `create index "oauthClientResource_resourceId_idx" on auth."oauthClientResource" ("resourceId")`,
  `create index "oauthRefreshToken_clientId_idx" on auth."oauthRefreshToken" ("clientId")`,
  `create index "oauthRefreshToken_sessionId_idx" on auth."oauthRefreshToken" ("sessionId")`,
  `create index "oauthRefreshToken_userId_idx" on auth."oauthRefreshToken" ("userId")`,
  `create index "oauthRefreshToken_authorizationCodeId_idx" on auth."oauthRefreshToken" ("authorizationCodeId")`,
  `create index "oauthAccessToken_clientId_idx" on auth."oauthAccessToken" ("clientId")`,
  `create index "oauthAccessToken_sessionId_idx" on auth."oauthAccessToken" ("sessionId")`,
  `create index "oauthAccessToken_userId_idx" on auth."oauthAccessToken" ("userId")`,
  `create index "oauthAccessToken_authorizationCodeId_idx" on auth."oauthAccessToken" ("authorizationCodeId")`,
  `create index "oauthAccessToken_refreshId_idx" on auth."oauthAccessToken" ("refreshId")`,
  `create index "oauthConsent_clientId_idx" on auth."oauthConsent" ("clientId")`,
  `create index "oauthConsent_userId_idx" on auth."oauthConsent" ("userId")`,
  `create unique index "account_issuer_accountId_uidx" on auth."account" ("issuer", "accountId")`,
  `create unique index "oauthClientResource_clientId_resourceId_uidx" on auth."oauthClientResource" ("clientId", "resourceId")`,
  `create unique index "deviceCode_deviceCode_uidx" on auth."deviceCode" ("deviceCode")`,
  `create unique index "deviceCode_userCode_uidx" on auth."deviceCode" ("userCode")`,
] as const;

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const statement of statements) await sql.raw(statement).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const tables = [
    "deviceCode",
    "oauthClientAssertion",
    "oauthConsent",
    "oauthAccessToken",
    "oauthRefreshToken",
    "oauthClientResource",
    "oauthResource",
    "oauthClient",
    "jwks",
    "verification",
    "account",
    "session",
    "user",
  ] as const;
  for (const table of tables) {
    await sql.raw(`drop table if exists auth."${table}" cascade`).execute(db);
  }
}
