# Third-party notices

This file lists the third-party components that Lynse bundles or adapts, along
with their licenses and upstream sources. License texts for MIT components are
reproduced at the bottom of this file.

## Bundled / adapted source code

| Component | License | Upstream | Notes |
| --- | --- | --- | --- |
| Humla | MIT | <https://github.com/michaelwilhelmsen/humla> | Parts of the macOS dual-stream recording architecture and audio-buffer handling are adapted from Humla. |
| whisper.cpp | MIT | <https://github.com/ggerganov/whisper.cpp> | Offline STT sidecar; vendors ggml (MIT) as a submodule. Built by `apps/tauri/scripts/fetch-sidecars.sh`. |
| moss-transcribe.cpp | MIT | <https://github.com/localai-org/moss-transcribe.cpp> | Offline STT / diarization sidecar; vendors ggml (MIT). The MOSS-Transcribe-Diarize model weights are Apache-2.0 (see the model card on Hugging Face). |
| FunASR | MIT | <https://github.com/modelscope/FunASR> | Python bridge for local transcription (Paraformer + FSMN VAD + CAM++). |

## Distributed binaries

| Component | License | Source of the binaries we distribute |
| --- | --- | --- |
| FFmpeg / ffprobe | LGPL-2.1-or-later (per build) | Windows: [BtbN FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds) (`*-lgpl` variant). macOS: [ffbinaries-prebuilt](https://github.com/ffbinaries/ffbinaries-prebuilt) v6.1. |

FFmpeg is distributed under the terms of the GNU Lesser General Public License.
The complete corresponding source code for FFmpeg is available from the
upstream projects linked above. The LGPL license text can be obtained at
<https://www.gnu.org/licenses/old-licenses/lgpl-2.1.txt>.

Model weights (Paraformer / FSMN VAD / CAM++, whisper, MOSS) are downloaded at
runtime from their respective publishers; refer to each model card for its
license terms.

## MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
