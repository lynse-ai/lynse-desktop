# License notice

Lynse Desktop
Copyright (c) 2026 上海天启灵光科技有限公司 (Shanghai RevelSpark Technologies Co., Ltd.)

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program.  If not, see <https://www.gnu.org/licenses/>.

## Scope of the AGPL grant

The AGPL-3.0-only grant covers the Lynse desktop and web clients (`apps/tauri`,
`apps/web`, `packages/`) and the repository tooling. `LICENSE` is kept as the
verbatim FSF license text so tooling can detect it; this file carries the
attribution and scope.

Two directories are **not** part of that grant:

| Path | License | Why it is separate |
| --- | --- | --- |
| `services/` | Proprietary, all rights reserved — see [services/LICENSE](services/LICENSE) | Lynse's closed integration BFF. Shares no source with the clients, is not in the pnpm workspace, and is reached only over the network. |
| `cloudfunctions/` | Proprietary, all rights reserved — see [cloudfunctions/LICENSE](cloudfunctions/LICENSE) | Deployed cloud functions, same separation as above. |

Because those programs are separately owned and not combined with the AGPL work,
no AGPL source-availability obligation attaches to them. Anyone running a
modified version of the clients against their own backend must implement the
documented interface themselves.

## Third-party components

Components bundled with or adapted into this software are listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and remain governed by their own
licenses (MIT, Apache-2.0, and the LGPL-2.1 terms applying to the FFmpeg and
ffprobe sidecars).
