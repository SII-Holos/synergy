from __future__ import annotations

import asyncio
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from functools import partial

_pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="benchmark-evidence")


async def background[**P, T](fn: Callable[P, T], *args: P.args, **kwargs: P.kwargs) -> T:
    task = asyncio.get_running_loop().run_in_executor(_pool, partial(fn, *args, **kwargs))
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        await task
        raise
