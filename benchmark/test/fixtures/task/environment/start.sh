#!/bin/sh
python /fixture/provider.py &
exec "$@"
