import { api } from "./client";

export interface HotwordVO {
  id: string;
  content: string;
  weight: number;
  createTime: string;
  updateTime: string;
}

export interface AddHotwordInput {
  content: string;
  weight?: number;
}

export interface UpdateHotwordInput {
  id: string;
  content: string;
  weight?: number;
}

/**
 * List all active (non-deleted) hotwords for the authenticated user,
 * ordered by createTime descending.
 */
export async function listHotwords(signal?: AbortSignal): Promise<HotwordVO[]> {
  const result = await api().get<HotwordVO[]>("/api/business/ai/hotword/list", { signal });
  return Array.isArray(result) ? result : [];
}

/**
 * Add a new user hotword.
 * Content is trimmed server-side and must be 1-20 characters.
 * Weight defaults to 3 (valid: 1-5 or 50).
 */
export async function addHotword(input: AddHotwordInput, signal?: AbortSignal): Promise<HotwordVO> {
  return await api().post<HotwordVO>("/api/business/ai/hotword/add", input, { signal });
}

/**
 * Update an existing hotword's content and/or weight.
 */
export async function updateHotword(input: UpdateHotwordInput, signal?: AbortSignal): Promise<boolean> {
  return await api().put<boolean>("/api/business/ai/hotword/update", input, { signal });
}

/**
 * Soft-delete a hotword by id.
 */
export async function deleteHotword(id: string, signal?: AbortSignal): Promise<boolean> {
  return await api().delete<boolean>(`/api/business/ai/hotword/delete?id=${encodeURIComponent(id)}`, { signal });
}
