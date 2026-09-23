from __future__ import annotations

import ipaddress
import json
import subprocess
from typing import Any

from .prepare import command

# Moby's local bridge defaults when the daemon declares no custom address pools.
# https://github.com/moby/moby/blob/v28.5.1/libnetwork/ipamutils/utils.go
DEFAULT_POOLS = [
    {"base": "172.17.0.0/16", "size": 16},
    {"base": "172.18.0.0/16", "size": 16},
    {"base": "172.19.0.0/16", "size": 16},
    {"base": "172.20.0.0/14", "size": 16},
    {"base": "172.24.0.0/14", "size": 16},
    {"base": "172.28.0.0/14", "size": 16},
    {"base": "192.168.0.0/16", "size": 20},
]


def available_subnets(pools: list[dict[str, Any]], occupied: list[str]) -> int:
    blocks = [ipaddress.ip_network(value, strict=False) for value in occupied]
    count = 0
    for pool in pools:
        base = ipaddress.ip_network(pool["base"] if "base" in pool else pool["Base"])
        size = int(pool["size"] if "size" in pool else pool["Size"])
        if base.version != 4:
            continue
        if not base.prefixlen <= size <= 32:
            raise ValueError("Invalid Docker address pool size")
        free = [base]
        for block in blocks:
            if block.version != 4:
                continue
            remainder = []
            for part in free:
                if not part.overlaps(block):
                    remainder.append(part)
                elif not part.subnet_of(block):
                    remainder.extend(part.address_exclude(block))
            free = remainder
        count += sum(2 ** (size - part.prefixlen) for part in free if part.prefixlen <= size)
    return count


def inspect_network_capacity(pools: list[dict[str, Any]]) -> int | None:
    try:
        identities = command(["docker", "network", "ls", "-q"], timeout=10).splitlines()
        networks = json.loads(command(["docker", "network", "inspect", *identities], timeout=10)) if identities else []
        occupied = [
            row["Subnet"]
            for network in networks
            for row in network.get("IPAM", {}).get("Config", []) or []
            if row.get("Subnet")
        ]
        routes = json.loads(command(["ip", "-j", "-4", "route", "show", "table", "all"], timeout=10))
        occupied.extend(row["dst"] for row in routes if row.get("dst") not in {None, "default", "0.0.0.0/0"})
        return available_subnets(pools, occupied)
    except (OSError, ValueError, TypeError, KeyError, subprocess.SubprocessError):
        return None
