import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { api } from "@lynse/core/api/client";
import { getAuthStore, useAuthStore } from "@lynse/core/auth";

// A disposable key shares the profile request within one session without
// retaining credentials in query keys or reusing another account's cache.
const profileSessions = new WeakMap<object, { token: string | null; key: string }>();
function profileSessionKey() {
  try {
    const client = api();
    const token = client.getToken();
    let session = profileSessions.get(client);
    if (!session || session.token !== token) {
      session = { token, key: crypto.randomUUID() };
      profileSessions.set(client, session);
    }
    return session.key;
  } catch {
    // A mounted, closed dialog need not have a client yet. Query execution
    // still reports initialization failures through its normal error state.
    return "not-initialized";
  }
}

export interface CustomerInfo {
  id: string;
  nickname: string;
  phone: string;
  pointsAmount: number;
  usedPointsAmount: number;
  benefitType?: string;
  avatarUrl?: string;
  [key: string]: unknown;
}

export interface MembershipQuota {
  memberLevel?: string;
  purchaseExpireTime?: string;
  cycleStartTime?: string;
  cycleEndTime?: string;
  totalMinutes?: number;
  usedMinutes?: number;
  remainingMinutes?: number;
  freeGiftRemainingMinutes?: number;
  paidPackageRemainingMinutes?: number;
  allRemainingMinutes?: number;
  unlimited?: boolean;
  [key: string]: unknown;
}

/** One row of GET /api/business/pointsLog/queryPointsLog (PointsLog VO). */
export interface PointsLogEntry {
  id?: string;
  createTime?: string;
  /** 0 purchase (充电包/加油包) · 1 consume · 2 moved-in · 3 transferred ·
   *  4 transcription-failure refund · 5 team-dissolution refund · 6 initial
   *  gift · 7 monthly login reward (observed server-side 2026-09-30). */
  changeType?: number;
  /** Entry amount in points (positive; direction comes from operationType). */
  pointsAmount?: number;
  /** "+" adds points, "−" consumes them; absent on some legacy rows. */
  operationType?: string;
  /** Free-text detail — booster purchases read 充电包充值（PAID），分钟数：N. */
  pointsDetails?: string | null;
  [key: string]: unknown;
}

function unpackLogRows(data: unknown): PointsLogEntry[] {
  if (Array.isArray(data)) return data;
  const o = (data ?? {}) as Record<string, PointsLogEntry[]>;
  return o.data ?? o.rows ?? o.list ?? [];
}

export interface PointsLedger {
  /** Newest-first rows from page 1 (for the recent-activity list). */
  recent: PointsLogEntry[];
}

/**
 * Personal points ledger: the recent rows backing the points-history dialog.
 * Balances are NOT derived from the log — customer/current and
 * membership/refresh already expose them as structured fields (see
 * resolveCreditsBalance); walking log text with heuristics double-counted
 * booster packs on both servers.
 */
export function usePointsLedger(recentCount = 50, pageSize = 100, maxPages = 10) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  return useQuery<PointsLedger>({
    queryKey: ["user", "pointsLedger", pageSize, maxPages],
    queryFn: async () => {
      const all: PointsLogEntry[] = [];
      for (let page = 1; page <= maxPages; page++) {
        const data = await api().getWithParams<unknown>(
          "/api/business/pointsLog/queryPointsLog",
          { pointsLogType: "personal", pageNum: page, pageSize },
        );
        const batch = unpackLogRows(data);
        all.push(...batch);
        if (batch.length < pageSize) break;
      }
      return { recent: all.slice(0, recentCount) };
    },
    enabled: isAuthenticated,
    staleTime: 60_000,
  });
}

/** The credits balance as one resolved figure. Credits and transcription
 *  minutes are the same currency (user decision 2026-11-27): the membership
 *  quota is authoritative wherever it exists, and the legacy points fields on
 *  customer/current (always 0 on the intl server) are only a fallback for
 *  accounts without any minute quota. */
export interface CreditsBalance {
  remaining: number;
  /** Quota total, null when the server exposes no total — the row then omits
   *  the "/ total" suffix and the progress bar. */
  total: number | null;
  /** Remaining minutes in separately purchased packs (时长包), shown as a
   *  chip; already included in `remaining`. */
  packRemaining: number;
  /** True when the balance comes from the membership minute quota rather
   *  than legacy points — the account card hides its separate minutes row in
   *  that case (same numbers twice). */
  minutesBased: boolean;
}

export function resolveCreditsBalance(
  credits?: CustomerInfo | null,
  membership?: MembershipQuota | null,
): CreditsBalance {
  const allRemaining = membership?.allRemainingMinutes ?? membership?.remainingMinutes;
  if (typeof allRemaining === "number") {
    const total = typeof membership?.totalMinutes === "number" ? membership!.totalMinutes : null;
    return {
      remaining: Math.max(0, allRemaining),
      total,
      packRemaining: Math.max(0, membership?.paidPackageRemainingMinutes ?? 0),
      minutesBased: true,
    };
  }
  const pointsTotal = credits?.pointsAmount ?? 0;
  const used = credits?.usedPointsAmount ?? 0;
  return {
    remaining: Math.max(0, pointsTotal - used),
    total: pointsTotal > 0 ? pointsTotal : null,
    packRemaining: 0,
    minutesBased: false,
  };
}

export function useUserCredits() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  return useQuery<CustomerInfo>({
    queryKey: ["user", "credits", profileSessionKey()],
    queryFn: async () => {
      const client = api();
      const token = client.getToken();
      const data = await client.get<Record<string, unknown>>("/api/business/customer/current");
      const auth = getAuthStore()?.getState();
      const id = String(data.userId ?? data.user_id ?? data.id ?? data.customerId ?? "").trim();
      // Session identity comes from the business profile, independently of
      // whether the optional suggestion inbox is enabled.
      if (id && client.getToken() === token && auth?.isAuthenticated && !auth.user?.id) {
        auth.setUser({ id, name: String(data.nickname ?? ""), email: String(data.email ?? "") });
      }
      return data as unknown as CustomerInfo;
    },
    enabled: isAuthenticated,
    staleTime: 60_000,
  });
}

/**
 * Updates the current customer's nickname via `PUT /api/business/customer`
 * (CustomerUpdateReq — only `nickname` is sent) and refreshes the cached
 * profile so every consumer (sidebar, dropdown trigger) re-renders.
 */
export function useUpdateNickname() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (nickname: string) => {
      await api().put<boolean>("/api/business/customer", { nickname });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["user", "credits"] });
    },
  });
}

/**
 * Fetches real membership tier and quota via the refresh endpoint.
 * Returns memberLevel, remaining minutes, etc.
 */
export function useMembership() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  return useQuery<MembershipQuota>({
    queryKey: ["user", "membership"],
    queryFn: async () => {
      const data = await api().get<Record<string, unknown>>("/api/business/customer/membership/refresh");
      return data as unknown as MembershipQuota;
    },
    enabled: isAuthenticated,
    staleTime: 60_000,
  });
}

/**
 * Returns true when an error represents "insufficient credits / balance" —
 * e.g. a transcription request rejected because the user ran out of points
 * or membership minutes. The Lynse backend surfaces this either via HTTP 402
 * or a message containing credit/balance keywords (Chinese or English).
 */
export function isInsufficientCreditsError(error: unknown): boolean {
  if (!error) return false;
  const status = (error as { status?: number }).status;
  if (status === 402) return true;
  const message = error instanceof Error ? error.message : String(error);
  if (!message) return false;
  const haystack = message.toLowerCase();
  return (
    haystack.includes("积分") ||
    haystack.includes("点数") ||
    haystack.includes("余额") ||
    haystack.includes("额度") ||
    haystack.includes("时长") ||
    haystack.includes("credit") ||
    haystack.includes("insufficient") ||
    haystack.includes("not enough") ||
    haystack.includes("quota") ||
    haystack.includes("balance") ||
    haystack.includes("expired")
  );
}
