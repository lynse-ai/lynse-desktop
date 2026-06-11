import { useQuery } from "@tanstack/react-query";
import { api } from "@lynse/core/api/client";
import { useAuthStore } from "@lynse/core/auth";

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

export function useUserCredits() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  return useQuery<CustomerInfo>({
    queryKey: ["user", "credits"],
    queryFn: async () => {
      const data = await api().get<Record<string, unknown>>("/api/business/customer/detail");
      return data as unknown as CustomerInfo;
    },
    enabled: isAuthenticated,
    staleTime: 60_000,
  });
}
