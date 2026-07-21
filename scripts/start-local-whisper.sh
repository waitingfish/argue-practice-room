#!/bin/sh
set -eu

PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
WHISPER_DIR="$PROJECT_DIR/.local/whisper.cpp"
SERVER_BIN="$WHISPER_DIR/build/bin/whisper-server"
MODEL_FILE="$WHISPER_DIR/models/ggml-base.bin"

if [ ! -x "$SERVER_BIN" ] || [ ! -f "$MODEL_FILE" ]; then
  echo "尚未安装本地语音识别，请先运行 npm run voice:setup"
  exit 1
fi

echo "本地语音识别启动：http://127.0.0.1:8080/inference"
exec "$SERVER_BIN" --host 127.0.0.1 --port 8080 -m "$MODEL_FILE" -l zh
