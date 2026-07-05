export type EditedTitleState = {
  itemId: string;
  title: string;
};

export function getDisplayTitle(
  selectedItemId: string | null,
  selectedTitle: string | null,
  editedTitle: EditedTitleState | null,
): string | null {
  if (selectedItemId && editedTitle?.itemId === selectedItemId) {
    return editedTitle.title;
  }
  return selectedTitle;
}
