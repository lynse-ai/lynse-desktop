import { redirect } from "next/navigation";
import { featureFlags } from "@lynse/views/feature-flags";
import { DevicesPage } from "@lynse/views/devices";

export default function Page() {
  // WIP feature — hidden from the release until its flag is flipped on.
  if (!featureFlags.devices) redirect("/");
  return <DevicesPage />;
}
