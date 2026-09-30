export interface CreateTodoBody {
  title: string;
  dueDate?: string;
  dueTime?: string;
  assignedTo?: string;
}

export interface UpdateTodoBody {
  title?: string;
  dueDate?: string | null;
  dueTime?: string | null;
  assignedTo?: string | null;
}

export interface TodoResponse {
  id: string;
  title: string;
  dueDate: string | null;
  /** "HH:MM", or null for any time that day. */
  dueTime: string | null;
  assignedTo: TodoAssignee | null;
  /** Who created it ("Assigned by"); null for to-dos made before this was recorded. */
  createdBy: TodoAssignee | null;
  isCompleted: boolean;
  completedAt: string | null;
  createdAt: string;
}

export interface TodoAssignee {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  avatarEmoji: string | null;
}

export interface GroupedTodosResponse {
  pending: TodoResponse[];
  completed: TodoResponse[];
}

export type TodoFilter = 'all' | 'assigned-to-me' | 'completed';

export interface TodoSummaryResponse {
  pending: number;
  completedToday: number;
}
