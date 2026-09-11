#!/usr/bin/env bash
# 크롬 웹스토어 업로드용 zip 생성. 확장에 필요한 파일만 담는다.
set -e
cd "$(dirname "$0")"

OUT="filterme-extension.zip"
rm -rf .pack "$OUT"
mkdir -p .pack

cp manifest.json content.js popup.html popup.js popup.css .pack/
cp -R icons .pack/

( cd .pack && zip -rqX "../$OUT" . )
rm -rf .pack

echo "생성: frontend/$OUT"
unzip -l "$OUT"
