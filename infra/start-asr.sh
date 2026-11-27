#!/bin/sh
set -eu

model=/models/ggml-base.bin
temporary="$model.download"
# Published by whisper.cpp in models/README.md at v1.7.6.
checksum=465707469ff3a37a2b9b8d8f89f2f99de7299dac
verified() {
    printf '%s  %s\n' "$checksum" "$1" | sha1sum --check --status
}

if ! verified "$model" 2>/dev/null; then
    trap 'rm -f "$temporary"' EXIT
    curl --silent --show-error --fail --location --proto '=https' --proto-redir '=https' --connect-timeout 15 \
        --max-time 300 --retry 1 --output "$temporary" \
        https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin
    verified "$temporary" || { printf '%s\n' 'Whisper model checksum mismatch' >&2; exit 1; }
    mv "$temporary" "$model"
    trap - EXIT
fi

exec whisper-server -m "$model" -l hi -t 2 --host 0.0.0.0 --port 8081 --no-timestamps
