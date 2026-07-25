"""Thin async client for the Gubbins bridge HTTP API, read-only by default.

The bridge (a separate Node companion service — see ``bridge/`` in the repo) is the
**only** data path. The client reads by default: it issues GET requests to the four documented
read endpoints. The exceptions are the five **opt-in** writes below, which only work when
the bridge itself is started with ``GUBBINS_BRIDGE_ALLOW_WRITES=on`` (otherwise the paths 404);
they round-trip through the app's own sync merge, never a bespoke database write. It uses Home
Assistant's shared aiohttp session, so the integration adds **no** third-party Python dependency.

Endpoints (all require ``Authorization: Bearer <token>``):
    GET  /health → { ok, itemCount, snapshotGeneratedAt }
    GET  /search?q=<query>&limit=<n> → { query, matches: [...] }
    GET  /where?q=<query> → { query, matches: [...], spoken }
    GET  /api/v1/status → { statuses: { "low-stock": n, ... }, snapshotGeneratedAt }
    POST /api/v1/items/<id>/adjust-quantity → updated item (opt-in; see above)
    POST /api/v1/items/<id>/adjust-gauge → updated item (opt-in; see above)
    POST /api/v1/items/<id>/check-out → { item, checkout } (opt-in; see above)
    POST /api/v1/items/<id>/check-in → { item, checkout } (opt-in; see above)
    POST /api/v1/items/<id>/transfer-stock → updated item (opt-in; see above)

The bridge's JSON is camelCase; Home Assistant service fields are snake_case. The mapping
between the two lives in this module (see :meth:`GubbinsClient.check_out`) so nothing above it
has to know either convention — and the bridge's *responses* are passed through untouched, so a
field the bridge adds later reaches an automation without a change here.
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


class GubbinsUnsupportedError(GubbinsError):
    """A read this build of the bridge does not serve (HTTP 404 on a read path).

    The integration can be newer than the bridge it is pointed at — they are updated
    separately — so a read added in a later release must degrade to "this entity has no
    value" rather than failing the whole config entry.
    """


class GubbinsClient:
    """A minimal HTTP client for one Gubbins bridge instance; reads, plus the opt-in writes."""

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

    async def _get(
        self,
        path: str,
        params: dict[str, str] | None = None,
        *,
        unsupported_on_404: bool = False,
    ) -> dict[str, Any]:
        """Issue a GET and return parsed JSON, mapping failures to typed errors.

        ``unsupported_on_404`` is set only for reads an *older* bridge legitimately will not
        have (see :class:`GubbinsUnsupportedError`). It stays off by default so that a 404
        on a long-standing path — the usual cause being the host/port pointing at something
        that isn't a Gubbins bridge at all — keeps reading as a connection failure, which is
        what the config flow tells the user about.
        """
        try:
            async with self._session.get(
                f"{self._base_url}{path}",
                params=params,
                headers=self._headers,
                timeout=_REQUEST_TIMEOUT,
            ) as response:
                if response.status == 401:
                    raise GubbinsAuthError("Bridge rejected the access token")
                if unsupported_on_404 and response.status == 404:
                    raise GubbinsUnsupportedError(f"This bridge does not serve {path}")
                response.raise_for_status()
                return await response.json()
        except (GubbinsAuthError, GubbinsUnsupportedError):
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

    async def statuses(self) -> dict[str, Any]:
        """GET /api/v1/status — how many items match each attention status.

        Backs the attention binary sensors. Every status is always present in the response
        (a status matching nothing is a ``0``), so the sensors never have to guess at a
        missing key. Raises :class:`GubbinsUnsupportedError` on a bridge predating the
        endpoint, which leaves those entities unavailable rather than failing the entry.
        """
        return await self._get("/api/v1/status", unsupported_on_404=True)

    async def adjust_quantity(
        self, item_id: str, delta: int, note: str | None = None
    ) -> dict[str, Any]:
        """POST /api/v1/items/<id>/adjust-quantity — add to or take from a DISCRETE item.

        ``delta`` > 0 adds stock, < 0 takes it away. This moves a *number* and nothing else —
        to record that a particular borrower has something, and get it back, use
        :meth:`check_out` / :meth:`check_in`. See :meth:`_write` for how the change reaches
        the app.
        """
        return await self._adjust("adjust-quantity", item_id, delta, note)

    async def adjust_gauge(
        self, item_id: str, delta: float, note: str | None = None
    ) -> dict[str, Any]:
        """POST /api/v1/items/<id>/adjust-gauge — change a CONSUMABLE_GAUGE item's contents.

        The gauge counterpart of :meth:`adjust_quantity`: ``delta`` is a signed change to the
        item's measured contents in its own unit (e.g. ``-45`` for 45 g of filament used), so
        it may be fractional. The app clamps the result to the item's empty/full bounds, and
        rejects the call if the item is not gauge-tracked.
        """
        return await self._adjust("adjust-gauge", item_id, delta, note)

    async def check_out(
        self,
        item_id: str,
        *,
        contact_name: str | None = None,
        contact_id: str | None = None,
        project_id: str | None = None,
        location_id: str | None = None,
        quantity: int | None = None,
        due_date: str | None = None,
        from_location_id: str | None = None,
        note: str | None = None,
    ) -> dict[str, Any]:
        """POST /api/v1/items/<id>/check-out — lend an item out.

        Exactly one borrower is supplied: a contact (by id, or by a name that is created if it
        matches nobody), a project, or a location such as a van. Which combinations are valid is
        the app's rule, not this client's — supplying none or several comes back as a clear
        rejection in the app's own words, so the rule is stated in one place rather than drifting
        between the two.

        ``due_date`` is a plain calendar day (``yyyy-MM-dd``). The app anchors it at the end of
        that day locally, so a loan due "the 20th" only counts as overdue once the 20th is over.

        Returns ``{ item, checkout }``: the loan's ``id`` is what :meth:`check_in` names later,
        and is the id the app's calendar feed embeds in that loan's event ``UID``.
        """
        body: dict[str, Any] = {
            key: value
            for key, value in (
                ("contactName", contact_name),
                ("contactId", contact_id),
                ("projectId", project_id),
                ("locationId", location_id),
                ("quantity", quantity),
                ("dueDate", due_date),
                ("fromLocationId", from_location_id),
                ("note", note),
            )
            if value is not None
        }
        return await self._write("check-out", item_id, body)

    async def check_in(
        self, item_id: str, checkout_id: str | None = None, note: str | None = None
    ) -> dict[str, Any]:
        """POST /api/v1/items/<id>/check-in — take a lent item back.

        ``checkout_id`` picks which loan to close, and is only needed once the item has more
        than one open at the same time: with a single open loan the item id alone is
        unambiguous, which is the case an automation reaching for "that's back now" actually
        has. Returns ``{ item, checkout }``, the checkout now marked returned.
        """
        body: dict[str, Any] = {}
        if checkout_id is not None:
            body["checkoutId"] = checkout_id
        if note is not None:
            body["note"] = note
        return await self._write("check-in", item_id, body)

    async def transfer_stock(
        self, item_id: str, from_location_id: str, to_location_id: str, quantity: int
    ) -> dict[str, Any]:
        """POST /api/v1/items/<id>/transfer-stock — move units between two locations.

        Changes *where* stock is, not how much of it there is: the item's total is the same
        afterwards. This is what :meth:`adjust_quantity` cannot express — that one only ever
        touches the item's home location.

        All of it moves or none does: too little at the source is a rejection, never a silent
        partial move. Returns the updated item, whose ``placements`` show the new split.
        """
        return await self._write(
            "transfer-stock",
            item_id,
            {
                "fromLocationId": from_location_id,
                "toLocationId": to_location_id,
                "quantity": quantity,
            },
        )

    async def _adjust(
        self, action: str, item_id: str, delta: float, note: str | None
    ) -> dict[str, Any]:
        """Build the ``{ delta, note? }`` body the two adjust endpoints share."""
        body: dict[str, Any] = {"delta": delta}
        if note is not None:
            body["note"] = note
        return await self._write(action, item_id, body)

    async def _write(self, action: str, item_id: str, body: dict[str, Any]) -> dict[str, Any]:
        """Issue one of the bridge's item writes, mapping failures to typed errors.

        The bridge applies the change through the app's own mutation and writes it back into
        the synced snapshot, so the PWA merges it conflict-free on its next sync — no bespoke
        database write. Only available when the bridge runs with
        ``GUBBINS_BRIDGE_ALLOW_WRITES=on``; otherwise the path is a 404 and
        :class:`GubbinsWritesDisabledError` is raised.
        """
        try:
            async with self._session.post(
                f"{self._base_url}/api/v1/items/{item_id}/{action}",
                json=body,
                headers=self._headers,
                timeout=_REQUEST_TIMEOUT,
            ) as response:
                if response.status == 401:
                    raise GubbinsAuthError("Bridge rejected the access token")
                if response.status == 404:
                    # Writes are disabled at the bridge, the id (item or loan) is unknown, or
                    # this bridge is older than the write itself — a 404 is deliberately the
                    # same answer for all of them, since a disabled capability is invisible
                    # rather than advertised. The service layer words that for the operator.
                    raise GubbinsWritesDisabledError(
                        "The bridge has writes disabled, or the record was not found"
                    )
                if 400 <= response.status < 500:
                    raise GubbinsRejectedError(await _error_message(response))
                response.raise_for_status()
                return await response.json()
        except (GubbinsAuthError, GubbinsWritesDisabledError, GubbinsRejectedError):
            raise
        except (aiohttp.ClientError, asyncio.TimeoutError) as err:
            raise GubbinsConnectionError(str(err)) from err

    async def where_answer(self, item: str) -> tuple[str, dict[str, Any] | None]:
        """Return ``(spoken sentence, raw payload)`` for an item lookup.

        On any failure this returns a friendly British-English fallback and a ``None``
        payload rather than raising, so the voice assistant never reads out a stack trace.
        The raw payload is what the intent handler turns into a bus event; the sentence is
        always usable regardless.
        """
        try:
            data = await self.where(item)
        except GubbinsAuthError:
            return (
                "Sorry, the Gubbins inventory bridge rejected my access token. "
                "Please check the integration settings.",
                None,
            )
        except GubbinsConnectionError:
            return "Sorry, I couldn't reach the Gubbins inventory bridge just now.", None

        payload = data if isinstance(data, dict) else None
        # The bridge always supplies a spoken sentence (including for no matches); the
        # guard below is belt-and-braces in case of an unexpected response shape.
        spoken = payload.get("spoken") if payload is not None else None
        if not isinstance(spoken, str) or not spoken.strip():
            return (
                f"Sorry, I couldn't find anything matching {item} in your inventory.",
                payload,
            )
        return spoken, payload

    async def where_spoken(self, item: str) -> str:
        """Return just the bridge's ready-to-speak sentence — see :meth:`where_answer`."""
        spoken, _payload = await self.where_answer(item)
        return spoken
