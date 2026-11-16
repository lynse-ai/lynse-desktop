import { registerPlugin } from "../registry";
import { registerTranscriptionModelPlugins } from "../transcription-models";
import { feishuBotPlugin } from "./feishu-bot";
import { gmailPlugin } from "./gmail";
import { knowledgeBasePlugin } from "./knowledge-base";
import { recordingCardUsbPlugin } from "./recording-card-usb";
import { workbuddyPlugin } from "./workbuddy";

/** Registration order defines the community listing order (top first). */
const builtinPlugins = [
  knowledgeBasePlugin,
  feishuBotPlugin,
  workbuddyPlugin,
  gmailPlugin,
  recordingCardUsbPlugin,
];

for (const plugin of builtinPlugins) {
  registerPlugin(plugin);
}

// Model plugins (kind: "model") join the same registry; the community renders
// them as the transcription-models category.
registerTranscriptionModelPlugins();
