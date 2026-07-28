export type FeishuAccount = {
  openId: string;
  unionId: string;
  userId?: string | null;
  name: string;
  enName?: string | null;
  avatarUrl?: string | null;
  email?: string | null;
  enterpriseEmail?: string | null;
  tenantKey?: string | null;
};

export type FeishuAuthState = {
  configured: boolean;
  redirectUri: string;
  authorized: boolean;
  account?: FeishuAccount | null;
  accessTokenExpiresAt?: string | null;
};

export type DesktopFeishuAuthApi = {
  getState(): Promise<FeishuAuthState>;
  authorize(): Promise<FeishuAuthState>;
  disconnect(): Promise<FeishuAuthState>;
};

export function getDesktopFeishuAuthApi(): DesktopFeishuAuthApi | null {
  if (typeof window === "undefined") return null;
  return (
    window as Window & {
      desktopAPI?: { feishuAuth?: DesktopFeishuAuthApi };
    }
  ).desktopAPI?.feishuAuth ?? null;
}
