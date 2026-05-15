/**
 * Local view-model types for the CF Team page components.
 * Kept separate so the several components that share these shapes
 * don't create circular imports.
 */

export interface TeamUser {
  id: string;
  name: string | null;
  email: string | null;
  image: string | null;
}

export interface RosterEmployee {
  role: string;
  displayName: string;
  status: "active" | "fired" | "idle";
  hired_at: number;
}

export interface ConversationMeta {
  id: string;
  started_at: number;
  ended_at: number | null;
  title: string | null;
}

export interface PlanItemRow {
  id: string;
  title?: string | null;
  description?: string | null;
  status?: string | null;
  owner_role?: string | null;
  created_at?: number | null;
  [key: string]: unknown;
}

export interface DraftRow {
  id: string;
  content?: string | null;
  platform?: string | null;
  status?: string | null;
  created_at?: number | null;
  [key: string]: unknown;
}
