"""Bounded local readiness check for CI's PostgreSQL-backed Mock API."""

import time

import httpx

deadline = time.monotonic() + 45
while time.monotonic() < deadline:
    try:
        response = httpx.get("http://127.0.0.1:18080/api/health", timeout=2, trust_env=False)
        response.raise_for_status()
        assert response.json()["providers"]["mock"] is True
        break
    except (httpx.HTTPError, KeyError):
        time.sleep(0.5)
else:
    raise SystemExit("Mock API did not become healthy within 45 seconds")
