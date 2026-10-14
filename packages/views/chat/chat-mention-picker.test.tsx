/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MentionChips } from "./chat-mention-picker";

vi.mock("@lynse/core/i18n/react", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

afterEach(cleanup);

describe("MentionChips skill chip", () => {
  it("renders nothing when there are no mentions and no pending skill", () => {
    const { container } = render(<MentionChips mentions={[]} onRemove={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows the pending skill as an accent chip with a remove button", () => {
    const onRemoveSkill = vi.fn();
    render(
      <MentionChips
        mentions={[]}
        onRemove={vi.fn()}
        skill={{ label: "会议纪要" }}
        onRemoveSkill={onRemoveSkill}
      />,
    );
    expect(screen.getByText("会议纪要")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /会议纪要/ }));
    expect(onRemoveSkill).toHaveBeenCalledOnce();
  });

  it("keeps rendering mention chips alongside the skill chip", () => {
    render(
      <MentionChips
        mentions={[{ kind: "note", id: "n1", title: "09-28 需求评审" }]}
        onRemove={vi.fn()}
        skill={{ label: "会议纪要" }}
        onRemoveSkill={vi.fn()}
      />,
    );
    expect(screen.getByText("09-28 需求评审")).toBeTruthy();
    expect(screen.getByText("会议纪要")).toBeTruthy();
  });
});
