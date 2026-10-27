"""E2E fixtures: drive the dev server (dj-lab-dev) with Playwright on the host.

The PIN gate cookie is the PIN_HASH from ~/config/dj-lab.env, read at test
time and never written anywhere.
"""

import os
from pathlib import Path

import pytest

ENV_FILE = Path.home() / "config" / "dj-lab.env"


def _pin_hash() -> str:
    for line in ENV_FILE.read_text().splitlines():
        key, sep, val = line.strip().partition("=")
        if sep and key == "PIN_HASH":
            return val.strip().strip('"').strip("'")
    return ""


@pytest.fixture(scope="session")
def base_url():
    return os.environ.get("DJLAB_E2E_URL", "http://127.0.0.1:8137")


@pytest.fixture(scope="session")
def auth_cookie(base_url):
    return {"name": "dj_auth", "value": _pin_hash(), "url": base_url}


@pytest.fixture(scope="session")
def playwright_instance():
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        yield p


@pytest.fixture(scope="session")
def chromium(playwright_instance):
    browser = playwright_instance.chromium.launch(
        args=["--autoplay-policy=no-user-gesture-required"])
    yield browser
    browser.close()


@pytest.fixture
def authed_context(chromium, auth_cookie):
    """A desktop Chromium context already past the PIN gate."""
    ctx = chromium.new_context(viewport={"width": 1400, "height": 900})
    ctx.add_cookies([auth_cookie])
    yield ctx
    ctx.close()


@pytest.fixture
def api(playwright_instance, base_url, auth_cookie):
    """An authed APIRequestContext for setup and cleanup calls."""
    req = playwright_instance.request.new_context(
        base_url=base_url,
        extra_http_headers={"Cookie": f"dj_auth={auth_cookie['value']}"})
    yield req
    req.dispose()
