export type ProviderId = 'antigravity' | 'codex' | 'claude' | 'kimi';
export type ActiveProviderId = 'antigravity' | 'codex';

export type UserPlanTier =
  | 'FREE'
  | 'PLUS'
  | 'PRO'
  | 'ULTRA'
  | 'TEAM'
  | 'ENTERPRISE'
  | 'EDU'
  | 'API_KEY';

export interface CachedQuotaMetric {
  plan: string;
  gemini: string;
  claudeGpt: string;
  argon: string;
  carbon?: string;
  gemini5h?: string;
  gemini5hReset?: string;
  gemini7d?: string;
  gemini7dReset?: string;
  claude5h?: string;
  claude5hReset?: string;
  claude7d?: string;
  claude7dReset?: string;
  geminiReset?: string;
  claudeReset?: string;
  argonReset?: string;
  carbonReset?: string;
  // Codex multi-window telemetry
  codex5h?: string;
  codex5hReset?: string;
  codex5hResetAtMs?: number;
  codex5hWindowMins?: number;
  codex7d?: string;
  codex7dReset?: string;
  codex7dResetAtMs?: number;
  codex7dWindowMins?: number;
  codexCodeReview?: string;
  codexCodeReviewReset?: string;
  codexCodeReviewResetAtMs?: number;
  codexResetCredits?: number;
  codexCreditsBalance?: string;
  updatedAt: number;
}

export type AuthHealthStatus = 'ok' | 'expired' | 'revoked' | 'error' | 'unverified';

export interface ProfileMetadata {
  id: string;
  provider?: ProviderId;
  name: string;
  email: string;
  accountId?: string;
  organizationId?: string;
  userId?: string;
  authMode?: 'chatgpt' | 'apikey';
  createdAt: number;
  updatedAt: number;
  tokenExpiryDate?: number;
  planOverride?: UserPlanTier;
  cachedQuota?: CachedQuotaMetric;
  authStatus?: AuthHealthStatus;
  authErrorCode?: string;
  authErrorMessage?: string;
  validationUrl?: string;
  authCheckedAt?: number;
}

export interface PrepareNewLoginResult {
  backedUpProfile: ProfileMetadata | null;
  wasExisting: boolean;
}

export interface CharlierState {
  activeProfileId: string | null;
  activeCodexProfileId?: string | null;
  selectedProvider?: ActiveProviderId;
  selectedProviderByHost?: Partial<Record<'antigravity' | 'vscode', ActiveProviderId>>;
  promptedUnsavedEmails?: string[];
  promptedUnsavedCodexIdentities?: string[];
  lastUpdated: number;
}

export interface LiveSessionInfo {
  email: string | null;
  accountId?: string | null;
  organizationId?: string | null;
  userId?: string | null;
  planTier?: UserPlanTier;
  authMode?: 'chatgpt' | 'apikey';
  hasOAuthCreds: boolean;
  tokenExpiryDate: number | null;
  isExpired: boolean;
  authStatus?: AuthHealthStatus;
  authErrorCode?: string;
  authErrorMessage?: string;
  validationUrl?: string;
}

export interface QuotaBucket {
  bucketId: string;
  displayName: string;
  description: string;
  window: string;
  remainingFraction: number;
  disabled?: boolean;
  resetTime?: string;
}

export interface QuotaGroup {
  displayName: string;
  description: string;
  buckets: QuotaBucket[];
}

export interface QuotaSummary {
  email?: string;
  accountId?: string;
  tier:
    | 'Free Tier'
    | 'Plus Plan'
    | 'Pro Plan'
    | 'Ultra Plan'
    | 'Team Plan'
    | 'Enterprise'
    | 'Edu Plan'
    | 'API Key'
    | 'Standard';
  planTier: UserPlanTier;
  groups: QuotaGroup[];
  hasArgonGroup: boolean;
  resetCredits?: number;
  creditsBalance?: string;
  authStatus?: AuthHealthStatus;
  authErrorCode?: string;
  authErrorMessage?: string;
  validationUrl?: string;
  fetchedAt: number;
}
