import { test, expect, openWorkspace } from "../fixtures/desktop-fixture";
import { completeOAuth, failNextRequest } from "../fixtures/integrations-mock";

/**
 * Connections: the `/api/v2/integrations` contract, exercised against the
 * stateful mock (`fixtures/integrations-mock.ts`).
 *
 * Two layers on purpose:
 *
 * 1. Contract-level tests drive the endpoints over HTTP. They run today, and
 *    they are what the front-end's `packages/core/integrations` module is
 *    written against — so they keep the mock and the client honest while the
 *    real backend is still unbuilt (PRD R4, mock-first).
 *  2. The UI test asserts the *gate*: `featureFlags.connections` is off until
 *  the backend deploys, so the section must not appear at all. Flip the flag
 *  and the same block is where the row-level flow tests go.
 */

const api = (mockUrl: string, path: string) => `${mockUrl}${path}`;

test.describe("connections contract", () => {
  test("full connect round trip: state -> browser -> poll -> exchange -> status", async ({
    page,
    mockServer,
  }) => {
    const state = await (
      await page.request.get(api(mockServer.url, "/api/v2/integrations/google-calendar/oauth-state?platform=desktop"))
    ).json();
    expect(state.state).toContain("state-google-calendar-");
    expect(state.redirect_uri).toBe("lynse://integration-callback");
    expect(state.authorization_url).toContain("accounts.example.com");

    // Still waiting on the user: the client must keep polling, not error.
    const pending = await (
      await page.request.get(
        api(mockServer.url, `/api/v2/integrations/google-calendar/oauth-result?state=${state.state}`),
      )
    ).json();
    expect(pending.status).toBe("pending");

    // Stand in for "the consent screen was completed in the system browser".
    expect(completeOAuth(mockServer.integrations, state.state)).toBe(true);
    const done = await (
      await page.request.get(
        api(mockServer.url, `/api/v2/integrations/google-calendar/oauth-result?state=${state.state}`),
      )
    ).json();
    expect(done.status).toBe("done");

    const exchanged = await (
      await page.request.post(api(mockServer.url, "/api/v2/integrations/google-calendar/exchange-code"), {
        data: { code: "c", state: state.state, redirect_uri: state.redirect_uri },
      })
    ).json();
    expect(exchanged.connected).toBe(true);
    // PRD §6.3 / AC-5: the client must never receive a third-party token.
    expect(JSON.stringify(exchanged)).not.toContain("access_token");
    expect(JSON.stringify(exchanged)).not.toContain("refresh_token");

    const status = await (
      await page.request.get(api(mockServer.url, "/api/v2/integrations/google-calendar/status"))
    ).json();
    expect(status.connected).toBe(true);
    expect(status.accounts).toHaveLength(1);
    expect(status.requires_pro).toBe(false);

    // Calendar events only flow once an account is connected and syncing.
    const events = await (
      await page.request.get(api(mockServer.url, "/api/v2/calendar/events?from=2000-01-01&to=2100-01-01"))
    ).json();
    expect(events.connected).toBe(true);
    expect(events.events[0].meeting_url).toBeTruthy();
  });

  test("a replayed or forged state is rejected, not silently accepted", async ({ page, mockServer }) => {
    const response = await page.request.post(
      api(mockServer.url, "/api/v2/integrations/google-calendar/exchange-code"),
      { data: { code: "c", state: "stolen" } },
    );
    expect(response.status()).toBe(400);
    expect((await response.json()).code).toBe("state_invalid");
  });

  test("multiple accounts per provider stay independent", async ({ page, mockServer }) => {
    for (const _ of [0, 1]) {
      const state = await (
        await page.request.get(api(mockServer.url, "/api/v2/integrations/todoist/oauth-state"))
      ).json();
      completeOAuth(mockServer.integrations, state.state);
      await page.request.post(api(mockServer.url, "/api/v2/integrations/todoist/exchange-code"), {
        data: { code: "c", state: state.state },
      });
    }
    const status = await (
      await page.request.get(api(mockServer.url, "/api/v2/integrations/todoist/status"))
    ).json();
    expect(status.accounts).toHaveLength(2);

    const first = status.accounts[0];
    await page.request.delete(
      api(mockServer.url, `/api/v2/integrations/todoist/disconnect?account_id=${first.id}`),
    );
    const after = await (
      await page.request.get(api(mockServer.url, "/api/v2/integrations/todoist/status"))
    ).json();
    expect(after.accounts).toHaveLength(1);
    expect(after.accounts[0].id).not.toBe(first.id);
  });

  test("export needs a destination, then reports partial success per item", async ({
    page,
    mockServer,
  }) => {
    const state = await (
      await page.request.get(api(mockServer.url, "/api/v2/integrations/google-tasks/oauth-state"))
    ).json();
    completeOAuth(mockServer.integrations, state.state);
    await page.request.post(api(mockServer.url, "/api/v2/integrations/google-tasks/exchange-code"), {
      data: { code: "c", state: state.state },
    });

    const bounced = await page.request.post(api(mockServer.url, "/api/v2/integrations/google-tasks/export"), {
      data: { action_item_ids: ["t1"] },
    });
    expect(bounced.status()).toBe(409);
    expect((await bounced.json()).code).toBe("no_destination");

    const destinations = await (
      await page.request.get(api(mockServer.url, "/api/v2/integrations/google-tasks/destinations"))
    ).json();
    expect(destinations.destinations.length).toBeGreaterThan(0);

    const saved = await page.request.put(
      api(mockServer.url, "/api/v2/integrations/google-tasks/default-destination"),
      { data: { account_id: "missing-account", destination_id: destinations.destinations[0].id } },
    );
    expect(saved.status()).toBe(404);

    const status = await (
      await page.request.get(api(mockServer.url, "/api/v2/integrations/google-tasks/status"))
    ).json();
    const ok = await page.request.put(
      api(mockServer.url, "/api/v2/integrations/google-tasks/default-destination"),
      { data: { account_id: status.accounts[0].id, destination_id: destinations.destinations[0].id } },
    );
    expect(ok.status()).toBe(200);

    const exported = await (
      await page.request.post(api(mockServer.url, "/api/v2/integrations/google-tasks/export"), {
        data: { action_item_ids: ["t1", "t-fail"], default_task_list_id: destinations.destinations[0].id },
      })
    ).json();
    expect(exported.succeeded).toHaveLength(1);
    expect(exported.failed).toHaveLength(1);
    expect(exported.failed[0].reason).toContain("export_item_failed");
  });

  test("the paywall and not-configured paths answer with the keys the client maps", async ({
    page,
    mockServer,
  }) => {
    const pro = await page.request.get(api(mockServer.url, "/api/v2/integrations/notion/oauth-state"));
    expect(pro.status()).toBe(403);
    expect((await pro.json()).message).toContain("requires_pro");

    const missing = await page.request.get(api(mockServer.url, "/api/v2/integrations/onedrive/status"));
    expect(missing.status()).toBe(503);
    expect((await missing.json()).message).toContain("not_configured");
  });

  test("auto-export and calendar toggles persist against the account", async ({ page, mockServer }) => {
    // notion is paywalled, so todoist carries the writable switches
    const st = await (
      await page.request.get(api(mockServer.url, "/api/v2/integrations/todoist/oauth-state"))
    ).json();
    completeOAuth(mockServer.integrations, st.state);
    const exchanged = await (
      await page.request.post(api(mockServer.url, "/api/v2/integrations/todoist/exchange-code"), {
        data: { code: "c", state: st.state },
      })
    ).json();
    const accountId = exchanged.account.id;

    await page.request.put(api(mockServer.url, "/api/v2/integrations/todoist/auto-export"), {
      data: { account_id: accountId, auto_export: true },
    });
    await page.request.put(api(mockServer.url, `/api/v2/calendar/accounts/${accountId}/toggles`), {
      data: { sync_enabled: false, notify_enabled: true },
    });

    const status = await (
      await page.request.get(api(mockServer.url, "/api/v2/integrations/todoist/status"))
    ).json();
    const account = status.accounts.find((a: { id: string }) => a.id === accountId);
    expect(account.auto_export).toBe(true);
    expect(account.sync_enabled).toBe(false);
    expect(account.notify_enabled).toBe(true);
  });

  test("an injected 500 surfaces once and then recovers", async ({ page, mockServer }) => {
    failNextRequest(mockServer.integrations, {
      method: "GET",
      pathPrefix: "/api/v2/integrations/google-tasks/status",
      status: 500,
      body: { message: "injected" },
    });
    const bad = await page.request.get(api(mockServer.url, "/api/v2/integrations/google-tasks/status"));
    expect(bad.status()).toBe(500);
    const good = await page.request.get(api(mockServer.url, "/api/v2/integrations/google-tasks/status"));
    expect(good.status()).toBe(200);
  });
});

test.describe("connections UI", () => {
  test("the section stays hidden while featureFlags.connections is off", async ({
    page,
    mockServer,
  }) => {
    await openWorkspace(page, mockServer.url);
    // The rail avatar's accessible name is the initials ("E2"), so target the
    // trigger by its title attribute (set from the nickname) instead.
    await page.locator('button[title="E2E Tester"]').click();
    await page.getByRole("menuitem", { name: "Settings" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();

    // Flip packages/views/feature-flags.ts to `connections: true` and this
    // assertion becomes the entry point for the row-level flow tests.
    await expect(page.getByRole("button", { name: "Connections" })).toHaveCount(0);
  });
});
