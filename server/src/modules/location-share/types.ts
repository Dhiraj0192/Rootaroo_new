export interface StartShareBody {
  durationMinutes: number;
  /** null = everyone else in the household. */
  viewerIds: string[] | null;
  latitude: number;
  longitude: number;
  accuracy?: number | null;
  /** Set when the share answers a ping; not accepted from the API. */
  pingRequestId?: string | null;
}

export interface UpdateShareLocationBody {
  latitude: number;
  longitude: number;
  accuracy?: number | null;
}

export interface LocationShareResponse {
  id: string;
  householdId: string;
  sharer: { id: string; displayName: string; avatarUrl: string | null };
  viewerIds: string[] | null;
  pingRequestId: string | null;
  startedAt: string;
  expiresAt: string;
  endedAt: string | null;
  /** Null once the share has ended: the last position is not kept. */
  latitude: number | null;
  longitude: number | null;
  accuracy: number | null;
  locationUpdatedAt: string;
}

export interface LocationSharesResponse {
  mine: LocationShareResponse | null;
  visible: LocationShareResponse[];
}
