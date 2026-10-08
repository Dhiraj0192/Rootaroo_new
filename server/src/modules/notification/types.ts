export interface DeviceTokenBody {
  token: string;
  platform: 'ios' | 'android' | 'web';
}

export interface NotificationHistoryResponse {
  id: string;
  type: string;
  title: string;
  body: string | null;
  data: Record<string, unknown> | null;
  isRead: boolean;
  readAt: string | null;
  createdAt: string;
}

export interface NotificationPreferencesResponse {
  newPost: boolean;
  taskAssigned: boolean;
  taskCompleted: boolean;
  checkIn: boolean;
  pingRequest: boolean;
  newExpense: boolean;
  chatMessage: boolean;
  calendarEvent: boolean;
  memberJoined: boolean;
  tips: boolean;
}

export interface UpdatePreferencesBody {
  newPost?: boolean;
  taskAssigned?: boolean;
  taskCompleted?: boolean;
  checkIn?: boolean;
  pingRequest?: boolean;
  newExpense?: boolean;
  chatMessage?: boolean;
  calendarEvent?: boolean;
  memberJoined?: boolean;
  tips?: boolean;
}
