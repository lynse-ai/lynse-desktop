/** Tiers allowed to upload audio to the cloud. These are the raw API values of
 *  `MembershipQuota.memberLevel` / `CustomerInfo.benefitType`, not the localized
 *  plan names the sidebar and profile menu render. */
const CLOUD_UPLOAD_TIERS: ReadonlySet<string> = new Set(["elite", "advanced", "premium"]);

/**
 * Whether this account may upload audio for cloud transcription and summary.
 *
 * An unknown tier is refused deliberately: the API returns the level as a
 * free-form string with no capability list, so anything outside the known paid
 * set is treated as not entitled. Admitting a new backend tier is then a
 * decision made here, not an accident of some new string arriving at runtime.
 *
 * `memberLevel` wins over `benefitType`, matching what the plan badges read.
 */
export function canUploadToCloud(
  membership?: { memberLevel?: string } | null,
  credits?: { benefitType?: string } | null,
): boolean {
  const tier = (membership?.memberLevel || credits?.benefitType || "").trim().toLowerCase();
  return CLOUD_UPLOAD_TIERS.has(tier);
}
