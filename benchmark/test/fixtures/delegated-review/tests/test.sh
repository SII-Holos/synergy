#!/bin/sh
mkdir -p /logs/verifier
if node /tests/verify.mjs > /logs/verifier/checks.txt 2>&1; then
  echo 1 > /logs/verifier/reward.txt
else
  echo 0 > /logs/verifier/reward.txt
fi
