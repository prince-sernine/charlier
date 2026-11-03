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

