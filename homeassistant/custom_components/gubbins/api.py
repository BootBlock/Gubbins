"""Thin async client for the Gubbins read-only bridge HTTP API.

The bridge (a separate Node companion service — see ``bridge/`` in the repo) is the
**only** data path. The client is read-only by default: it issues GET requests to the three
documented endpoints. The one exception is :meth:`GubbinsClient.adjust_quantity`, an **opt-in**
write that only works when the bridge itself is started with ``GUBBINS_BRIDGE_ALLOW_WRITES=on``
(otherwise the path 404s); it round-trips through the app's own sync merge, never a bespoke
database write. It uses Home Assistant's shared aiohttp session, so the integration adds **no**
third-party Python dependency.

Endpoints (all require ``Authorization: Bearer <token>``):
    GET  /health → { ok, itemCount, snapshotGeneratedAt }
    GET  /search?q=<query>&limit=<n> → { query, matches: [...] }
    GET  /where?q=<query> → { query, matches: [...], spoken }
    POST /api/v1/items/<id>/adjust-quantity → updated item (opt-in; see above)
"""

from __future__ import annotations

import asyncio
from typing import Any

import aiohttp

_REQUEST_TIMEOUT = aiohttp.ClientTimeout(total=10)


async def _error_message(response: aiohttp.ClientResponse) -> str:
    """Pull the human message out of the bridge's ``{ error: { code, message } }`` envelope.

    Falls back to a generic line if the body isn't the expected shape, so a rejection never
    surfaces a stack trace.
    """
    try:
        body = await response.json()
        error = body.get("error") if isinstance(body, dict) else None
        if isinstance(error, dict) and isinstance(error.get("message"), str):
            return error["message"]
    except (aiohttp.ClientError, ValueError):
        pass
    return "The bridge rejected the change."


class GubbinsError(Exception):
    """Base error for any bridge interaction."""


class GubbinsAuthError(GubbinsError):
    """The bridge rejected the bearer token (HTTP 401)."""


class GubbinsConnectionError(GubbinsError):
    """The bridge could not be reached, timed out, or returned an unexpected status."""


class GubbinsWritesDisabledError(GubbinsError):
    """A write was attempted but the bridge has writes disabled (HTTP 404 on the path).

    The bridge is read-only unless started with ``GUBBINS_BRIDGE_ALLOW_WRITES=on``.
    """


class GubbinsRejectedError(GubbinsError):
    """The bridge accepted the request but rejected the change (HTTP 4xx, e.g. below zero)."""


class GubbinsClient:
    """A minimal, read-only HTTP client for one Gubbins bridge instance."""

    def __init__(
        self,
        session: aiohttp.ClientSession,
        host: str,
        port: int,
        token: str,
    ) -> None:
        self._session = session
        self._base_url = f"http://{host}:{port}"
        self._headers = {"Authorization": f"Bearer {token}"}

    async def _get(self, path: str, params: dict[str, str] | None = None) -> dict[str, Any]:
        """Issue a GET and return parsed JSON, mapping failures to typed errors."""
        try:
            async with self._session.get(
                f"{self._base_url}{path}",
                params=params,
                headers=self._headers,
                timeout=_REQUEST_TIMEOUT,
            ) as response:
                if response.status == 401:
                    raise GubbinsAuthError("Bridge rejected the access token")
                response.raise_for_status()
                return await response.json()
        except GubbinsAuthError:
            raise
        except (aiohttp.ClientError, asyncio.TimeoutError) as err:
            raise GubbinsConnectionError(str(err)) from err

    async def health(self) -> dict[str, Any]:
        """GET /health — used by the config-flow connection test and the sensor."""
        return await self._get("/health")

    async def where(self, item: str) -> dict[str, Any]:
        """GET /where?q=<item> — the full answer including the spoken sentence."""
        return await self._get("/where", {"q": item})

    async def search(self, query: str, limit: int | None = None) -> dict[str, Any]:
        """GET /search?q=<query>&limit=<n> — compact item matches."""
        params: dict[str, str] = {"q": query}
        if limit is not None:
            params["limit"] = str(limit)
        return await self._get("/search", params)

    async def adjust_quantity(
        self, item_id: str, delta: int, note: str | None = None
    ) -> dict[str, Any]:
        """POST /api/v1/items/<id>/adjust-quantity — the integration's only write.

        Checks a DISCRETE item in (``delta`` > 0) or out (``delta`` < 0). The bridge applies
        it through the app's own mutation and writes the change back into the synced snapshot,
        so the PWA merges it conflict-free on its next sync — no bespoke database write. Only
        available when the bridge runs with ``GUBBINS_BRIDGE_ALLOW_WRITES=on``; otherwise the
        path is a 404 and :class:`GubbinsWritesDisabledError` is raised.
        """
        body: dict[str, Any] = {"delta": delta}
        if note is not None:
            body["note"] = note
        try:
            async with self._session.post(
                f"{self._base_url}/api/v1/items/{item_id}/adjust-quantity",
                json=body,
                headers=self._headers,
                timeout=_REQUEST_TIMEOUT,
            ) as response:
                if response.status == 401:
                    raise GubbinsAuthError("Bridge rejected the access token")
                if response.status == 404:
                    # Either writes are disabled at the bridge, or the item id is unknown.
                    raise GubbinsWritesDisabledError(
                        "The bridge has writes disabled or the item was not found"
                    )
                if 400 <= response.status < 500:
                    raise GubbinsRejectedError(await _error_message(response))
                response.raise_for_status()
                return await response.json()
        except (GubbinsAuthError, GubbinsWritesDisabledError, GubbinsRejectedError):
            raise
        except (aiohttp.ClientError, asyncio.TimeoutError) as err:
            raise GubbinsConnectionError(str(err)) from err

    async def where_spoken(self, item: str) -> str:
        """Return the bridge's ready-to-speak sentence for an item.

        On any failure this returns a friendly British-English fallback rather than
        raising, so the voice assistant never reads out a stack trace.
        """
        try:
            data = await self.where(item)
        except GubbinsAuthError:
            return (
                "Sorry, the Gubbins inventory bridge rejected my access token. "
                "Please check the integration settings."
            )
        except GubbinsConnectionError:
            return "Sorry, I couldn't reach the Gubbins inventory bridge just now."

        # The bridge always supplies a spoken sentence (including for no matches); the
        # guard below is belt-and-braces in case of an unexpected response shape.
        spoken = data.get("spoken")
        if not isinstance(spoken, str) or not spoken.strip():
            return f"Sorry, I couldn't find anything matching {item} in your inventory."
        return spoken
