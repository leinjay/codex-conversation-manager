export type SessionSource = "local" | "cloud";

export interface SessionRecord {
  key: string;
  source: SessionSource;
  id: string;
  title: string;
  preview?: string;
  cwd?: string;
  projectLabel: string;
  sourceLabel?: string;
  status?: string;
  createdAt?: number;
  updatedAt?: number;
  recencyAt?: number;
  lastTurnEndedAt?: number;
  url?: string;
  environmentId?: string;
  environmentLabel?: string;
  raw: Record<string, unknown>;
}

export interface LocalPage {
  records: SessionRecord[];
  cursor?: string | null;
}

export interface CloudPage {
  records: SessionRecord[];
  cursor?: string | null;
}

export interface SourceErrors {
  local?: string;
  cloud?: string;
}

export interface UsageBucket {
  key: string;
  label: string;
  primary?: {
    usedPercent?: number;
    windowDurationMins?: number;
    resetsAt?: number;
  };
  secondary?: {
    usedPercent?: number;
    windowDurationMins?: number;
    resetsAt?: number;
  };
}

export interface UsageResetCredit {
  expiresAt?: number;
}

export interface UsageSnapshot {
  accountStatus: "available" | "unavailable" | "error";
  email?: string;
  planType?: string;
  authType?: string;
  accountMessage?: string;
  quotaStatus: "available" | "unavailable" | "error";
  quotaMessage?: string;
  buckets: UsageBucket[];
  availableResetCount?: number;
  resetCredits?: UsageResetCredit[];
  tokenStatus: "available" | "unavailable" | "error";
  tokenMessage?: string;
  tokenSummary?: Record<string, number | null | undefined>;
  dailyUsageBuckets?: Array<{ startDate?: string; tokens?: number }>;
}

export interface CliStatus {
  platform: NodeJS.Platform;
  path?: string;
  source: "configured" | "chatgpt" | "PATH" | "missing";
  configuredPath?: string;
  verified?: boolean;
  version?: string;
  verificationMessage?: string;
  codexHome?: string;
  hostEnvironment: string;
  remoteWarning?: string;
}

export interface ManagerSnapshot {
  accounts?: AccountSnapshot;
  records: SessionRecord[];
  projects: string[];
  sourceFilter: "all" | "local" | "cloud";
  projectFilter: string;
  search: string;
  sortKey: "created" | "updated" | "active";
  sortDirection: "asc" | "desc";
  pageIndex: number;
  pageSize: number;
  totalLoaded: number;
  filteredCount: number;
  hasMore: boolean;
  errors: SourceErrors;
  usage?: UsageSnapshot;
  listRefreshedAt?: number;
  cli: CliStatus;
  loading: boolean;
  message?: string;
}

export interface SavedAccount {
  id: string;
  email: string;
  accountId: string;
  planType?: string;
  state: "saved" | "reauth" | "cacheMissing";
}

export interface AccountSnapshot {
  items: Array<SavedAccount & { quota?: AccountQuotaSnapshot }>;
  currentId?: string;
  currentQuota?: AccountQuotaSnapshot;
  refreshingQuotas?: boolean;
  busy: boolean;
  canCancel: boolean;
  currentEmail?: string;
  targetEmail?: string;
  phase: "unverified" | "reloadRequired" | "confirmationRequired" | "confirmed";
  message?: string;
}

export interface AccountQuotaSnapshot {
  status: "loading" | "available" | "unavailable" | "error" | "reauth" | "cacheMissing";
  text?: string;
  checkedAt?: number;
  refreshText?: string;
}
