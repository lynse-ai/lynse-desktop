/**
 * Default mock responses for the Lynse backend (`/api/business/**` etc.).
 * Shapes mirror the interfaces in packages/views/workspace/types.ts.
 */

export const MOCK_USER = {
  id: "user-e2e",
  nickname: "E2E Tester",
  email: "e2e@test.local",
  username: "e2e-tester",
};

export const MOCK_FOLDERS = [
  { id: "folder-work", folderName: "Work", sort: 1, createTime: "2026-08-01T09:00:00Z" },
  { id: "folder-team", folderName: "Team", sort: 2, createTime: "2026-08-02T09:00:00Z" },
];

export const MOCK_FILES = [
  {
    id: "file-q3-review",
    originalFilename: "Q3 review.m4a",
    createdAt: "2026-09-01T10:00:00Z",
    updatedAt: "2026-09-01T11:00:00Z",
    folderId: "folder-work",
    status: "done",
    fileSize: 12_000_000,
    tags: ["quarterly"],
  },
  {
    id: "file-kickoff",
    originalFilename: "project kickoff.mp3",
    createdAt: "2026-09-03T14:00:00Z",
    updatedAt: "2026-09-03T15:30:00Z",
    folderId: "folder-work",
    status: "done",
    fileSize: 8_500_000,
    tags: [],
  },
];

export const MOCK_TODOS = [
  {
    todoId: "todo-1",
    content: "Send the Q3 summary to the team",
    isCompleted: 0,
    fileId: "file-q3-review",
    createTime: "2026-09-01T11:05:00Z",
  },
];

/**
 * Path-prefix → response-body map used by the mock server's catch-all.
 * Query params and method are ignored; specific tests may override routes.
 */
export function defaultJsonRoutes(): Record<string, unknown> {
  return {
    "/api/business/customer/current": MOCK_USER,
    "/api/business/customer/membership/refresh": { level: "free", credits: 100 },
    "/api/business/file/folder/list": MOCK_FOLDERS,
    "/api/business/file/page": { list: MOCK_FILES, total: MOCK_FILES.length, pages: 1 },
    "/api/business/file/todo/listall": MOCK_TODOS,
    "/api/business/file/category/count": {},
    "/api/business/file/conclusion/list": [],
    "/api/business/file/timeRange/list": MOCK_FILES,
    "/api/business/file/outline/get": { outline: [] },
    "/api/business/file/info": MOCK_FILES[0],
    "/api/business/translate/prompt/categories": [],
    "/api/auth/apikey/token": { accessToken: "e2e-access-token" },
  };
}
