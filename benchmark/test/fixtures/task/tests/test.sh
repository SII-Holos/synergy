#!/bin/sh
mkdir -p /logs/verifier
if test "$(cat /app/marker 2>/dev/null)" = verified; then
  echo 1 > /logs/verifier/reward.txt
else
  echo 0 > /logs/verifier/reward.txt
fi
