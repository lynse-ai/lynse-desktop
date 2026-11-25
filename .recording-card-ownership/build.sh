#!/usr/bin/env bash
set -euo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
native="$root/apps/tauri/src-tauri/recording-card-ownership"
web="$root/apps/web/app/api/(private-plugins)/recording-card/ownership"
source_file="$root/.recording-card-ownership/verify.c"
scratch="$(mktemp -d)"
trap 'rm -rf -- "$scratch"' EXIT

linker="$(rustc --print sysroot)/lib/rustlib/$(rustc -vV | sed -n 's/^host: //p')/bin/rust-lld"
flags=(-O2 -g0 -Wall -Wextra -Werror -ffreestanding -fno-builtin -fno-stack-protector -fvisibility=hidden -fno-ident)
for target in aarch64-apple-darwin x86_64-apple-darwin x86_64-pc-windows-msvc x86_64-pc-windows-gnu x86_64-unknown-linux-gnu aarch64-unknown-linux-gnu; do
    mkdir -p "$native/$target"
    clang --target="$target" "${flags[@]}" -c "$source_file" -o "$scratch/verify.o"
    case "$target" in
        *-apple-*) ZERO_AR_DATE=1 xcrun ar rcs "$native/$target/librecording_card_owner.a" "$scratch/verify.o" ;;
        *-msvc)
            (cd "$scratch" && "$linker" -flavor link /lib "/out:$native/$target/recording_card_owner.lib" verify.o)
            ;;
        *-windows-gnu|*-linux-gnu)
            x86_64-w64-mingw32-ar rcsD "$scratch/librecording_card_owner.a" "$scratch/verify.o"
            mv -f "$scratch/librecording_card_owner.a" "$native/$target/"
            ;;
    esac
done

mkdir -p "$web"
clang --target=wasm32-unknown-unknown "${flags[@]}" -c "$source_file" -o "$scratch/verify.wasm.o"
"$linker" -flavor wasm --no-entry --strip-all --export=rc_owner_match_v1 --export=rc_owner_input_v1 \
    "$scratch/verify.wasm.o" -o "$web/verify.wasm"
chmod 644 "$web/verify.wasm"
