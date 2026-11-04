export interface ProfileMetadata {
  id: string;
  name: string;
  email: string;
  createdAt: number;
  updatedAt: number;
  tokenExpiryDate?: number;
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
  tier: 'Pro Plan' | 'Ultra Plan' | 'Standard';
  groups: QuotaGroup[];
  hasArgonGroup: boolean;
  fetchedAt: number;
}


