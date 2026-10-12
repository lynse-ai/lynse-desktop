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

/** The 加油包 (booster) is a separate bucket the server only spends once the
 *  regular points are exhausted, yet customer/current exposes no balance for
 *  it — the only machine-readable trace is the points log itself:
 *  purchases are changeType 0 rows ("充电包充值…"), booster consumption rows
 *  mention 加油包/充电包/新积分 in pointsDetails. Balance = purchased − used. */
function isBoosterPurchase(row: PointsLogEntry): boolean {
  return row.changeType === 0 && row.operationType !== "-";
}
function isBoosterConsumption(row: PointsLogEntry): boolean {
  if (row.operationType !== "-") return false;
  const detail = typeof row.pointsDetails === "string" ? row.pointsDetails : "";
  return /加油包|充电包|新积分/.test(detail);
}

export interface PointsLedger {
  /** Newest-first rows from page 1 (for the recent-activity list). */
  recent: PointsLogEntry[];
  /** 加油包 remaining, computed from the full log; null while loading. */
  boosterRemaining: number | null;
  /** Total 加油包 points ever purchased. */
  boosterPurchased: number;
  /** Cumulative monthly-login-reward points ever granted (changeType 7). */
  monthlyGiftTotal: number;
}

/**
 * Personal points ledger: the recent rows for the activity list plus the
 * booster-pack balance derived by walking the whole log (bounded — see
 * maxPages; accounts older/larger than the cap get a slightly understated
 * booster balance rather than an error).
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
      let boosterRemaining = 0;
      let boosterPurchased = 0;
      let monthlyGiftTotal = 0;
      for (const row of all) {
        if (isBoosterPurchase(row)) {
          boosterPurchased += Number(row.pointsAmount) || 0;
          boosterRemaining += Number(row.pointsAmount) || 0;
        } else if (isBoosterConsumption(row)) {
          boosterRemaining -= Number(row.pointsAmount) || 0;
        }
        if (row.changeType === 7 && row.operationType !== "-") {
          monthlyGiftTotal += Number(row.pointsAmount) || 0;
        }
      }
      return {
        recent: all.slice(0, recentCount),
        boosterRemaining: Math.max(0, boosterRemaining),
        boosterPurchased,
        monthlyGiftTotal,
      };
    },
    enabled: isAuthenticated,
    staleTime: 60_000,
  });
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
