#!/bin/sh
set -eu

PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
WHISPER_DIR="$PROJECT_DIR/.local/whisper.cpp"

command -v git >/dev/null 2>&1 || { echo "缺少 git，请先安装 Xcode Command Line Tools。"; exit 1; }
command -v cmake >/dev/null 2>&1 || { echo "缺少 cmake，可运行：brew install cmake"; exit 1; }

mkdir -p "$PROJECT_DIR/.local"
if [ ! -d "$WHISPER_DIR/.git" ]; then
  git clone --depth 1 https://github.com/ggml-org/whisper.cpp.git "$WHISPER_DIR"
fi

cmake -S "$WHISPER_DIR" -B "$WHISPER_DIR/build" -DCMAKE_BUILD_TYPE=Release
cmake --build "$WHISPER_DIR/build" --config Release -j 4

if [ ! -f "$WHISPER_DIR/models/ggml-base.bin" ]; then
  sh "$WHISPER_DIR/models/download-ggml-model.sh" base
fi

echo "本地语音识别已安装。运行 npm run voice:start 启动。"
