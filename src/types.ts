export type UserPlanTier = 'FREE' | 'PRO' | 'ULTRA' | 'ENTERPRISE';

export interface CachedQuotaMetric {
  plan: string;
  gemini: string;
  claudeGpt: string;
  argon: string;
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
  updatedAt: number;
}

export interface ProfileMetadata {
  id: string;
  name: string;
  email: string;
  createdAt: number;
  updatedAt: number;
  tokenExpiryDate?: number;
  planOverride?: UserPlanTier;
  cachedQuota?: CachedQuotaMetric;
}

export interface PrepareNewLoginResult {
  backedUpProfile: ProfileMetadata | null;
  wasExisting: boolean;
}

export interface CharlierState {
  activeProfileId: string | null;
  lastUpdated: number;
}

export interface LiveSessionInfo {
  email: string | null;
  hasOAuthCreds: boolean;
  tokenExpiryDate: number | null;
  isExpired: boolean;
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
  tier: 'Free Tier' | 'Pro Plan' | 'Ultra Plan' | 'Enterprise' | 'Standard';
  planTier: UserPlanTier;
  groups: QuotaGroup[];
  hasArgonGroup: boolean;
  fetchedAt: number;
}
