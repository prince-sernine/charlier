export interface CachedQuotaMetric {
  plan: string;
  gemini: string;
  claudeGpt: string;
  argon: string;
  updatedAt: number;
}

export interface ProfileMetadata {
  id: string;
  name: string;
  email: string;
  createdAt: number;
  updatedAt: number;
  tokenExpiryDate?: number;
  cachedQuota?: CachedQuotaMetric;
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

export type UserPlanTier = 'FREE' | 'PRO' | 'ULTRA' | 'ENTERPRISE';

export interface QuotaSummary {
  tier: 'Free Tier' | 'Pro Plan' | 'Ultra Plan' | 'Enterprise' | 'Standard';
  planTier: UserPlanTier;
  groups: QuotaGroup[];
  hasArgonGroup: boolean;
  fetchedAt: number;
}
