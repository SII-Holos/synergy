from __future__ import annotations

import asyncio
import contextlib
import hashlib
import ipaddress
import os
from collections.abc import AsyncIterator
from contextvars import ContextVar
from types import TracebackType
from urllib.parse import urlsplit

from .prepare import command

current_dependency_proxy: ContextVar[str | None] = ContextVar("dependency_proxy", default=None)


def proxy_from_environment(reference: str | None) -> str | None:
    if reference is None:
        return None
    value = os.environ.get(reference)
    if not value:
        raise ValueError(f"Missing dependency proxy environment variable: {reference}")
    try:
        parsed = urlsplit(value)
        valid = (
            parsed.scheme == "http"
            and parsed.hostname
            and parsed.port
            and not (parsed.username or parsed.password or parsed.query or parsed.fragment)
            and parsed.path in {"", "/"}
        )
    except ValueError:
        valid = False
    if not valid:
        raise ValueError("Dependency proxy requires an HTTP URL with a port and without credentials, query or path")
    return value.rstrip("/")


def dependency_environment(url: str) -> dict[str, str]:
    no_proxy = "localhost,127.0.0.1,::1,host.docker.internal"
    return {
        "HTTP_PROXY": url,
        "HTTPS_PROXY": url,
        "http_proxy": url,
        "https_proxy": url,
        "NO_PROXY": no_proxy,
        "no_proxy": no_proxy,
    }


def dependency_proxy_identity(reference: str | None) -> dict[str, str] | None:
    url = proxy_from_environment(reference)
    if url is None:
        return None
    return {"endpoint_sha256": hashlib.sha256(url.encode()).hexdigest(), "policy": "internet-enabled-environments-only"}


class DependencyRelay:
    """Forward a loopback HTTP proxy on the Docker bridge without exposing it on the LAN."""

    def __init__(self, upstream: str, bind_host: str) -> None:
        self.upstream = urlsplit(upstream)
        self.bind_host = bind_host
        self.connections: set[asyncio.Task[None]] = set()
        self.writers: set[asyncio.StreamWriter] = set()
        self.server: asyncio.Server | None = None
        self.port = 0

    async def __aenter__(self) -> DependencyRelay:
        self.server = await asyncio.start_server(self._accept, self.bind_host, 0)
        self.port = int(self.server.sockets[0].getsockname()[1])
        return self

    async def __aexit__(
        self, kind: type[BaseException] | None, error: BaseException | None, traceback: TracebackType | None
    ) -> None:
        if self.server:
            self.server.close()
        for writer in self.writers:
            writer.close()
        connections = tuple(self.connections)
        for task in connections:
            task.cancel()
        await asyncio.gather(*connections, return_exceptions=True)
        self.writers.clear()
        if self.server:
            await self.server.wait_closed()

    def _accept(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        self.writers.add(writer)
        task = asyncio.create_task(self._forward(reader, writer))
        self.connections.add(task)
        task.add_done_callback(self.connections.discard)

    async def _forward(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        upstream_writer = None
        transfers: list[asyncio.Task[None]] = []

        async def copy(source: asyncio.StreamReader, target: asyncio.StreamWriter) -> None:
            while chunk := await source.read(65536):
                target.write(chunk)
                await target.drain()

        try:
            async with asyncio.timeout(30):
                upstream_reader, upstream_writer = await asyncio.open_connection(
                    self.upstream.hostname, self.upstream.port
                )
                self.writers.add(upstream_writer)
            transfers = [
                asyncio.create_task(copy(reader, upstream_writer)),
                asyncio.create_task(copy(upstream_reader, writer)),
            ]
            await asyncio.wait(transfers, return_when=asyncio.FIRST_COMPLETED)
        except (OSError, TimeoutError):
            pass
        finally:
            for transfer in transfers:
                transfer.cancel()
            await asyncio.gather(*transfers, return_exceptions=True)
            for connection in [writer, upstream_writer]:
                if connection is not None:
                    connection.close()
                    self.writers.discard(connection)
                    with contextlib.suppress(OSError, TimeoutError):
                        async with asyncio.timeout(5):
                            await connection.wait_closed()


@contextlib.asynccontextmanager
async def dependency_proxy(reference: str | None) -> AsyncIterator[None]:
    upstream = proxy_from_environment(reference)
    if upstream is None:
        yield
        return
    hostname = urlsplit(upstream).hostname
    try:
        loopback = ipaddress.ip_address(str(hostname)).is_loopback
    except ValueError:
        loopback = hostname == "localhost"
    async with contextlib.AsyncExitStack() as stack:
        url = upstream
        if loopback:
            bridge = await asyncio.to_thread(
                command, ["docker", "network", "inspect", "bridge", "--format", "{{(index .IPAM.Config 0).Gateway}}"]
            )
            ipaddress.ip_address(bridge)
            relay = await stack.enter_async_context(DependencyRelay(upstream, bridge))
            url = f"http://host.docker.internal:{relay.port}"
        token = current_dependency_proxy.set(url)
        try:
            yield
        finally:
            current_dependency_proxy.reset(token)
