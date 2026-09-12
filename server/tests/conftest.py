import os

# Provide safe defaults for required settings so the test suite is
# self-contained and does not depend on a local .env file existing.
# Uses setdefault so a real local .env (loaded by pydantic-settings)
# still takes precedence when present.
os.environ.setdefault("LLM_PROVIDER", "offline")
os.environ.setdefault("MODEL_NAME", "test-model")
os.environ.setdefault("OFFLINE_API_BASE", "http://localhost:11434/v1")
os.environ.setdefault("BACKEND_API_KEY", "test-api-key")
os.environ.setdefault("ALLOWED_ORIGINS", "http://localhost:3000")

import pytest
from fastapi.testclient import TestClient
from app.main import app
from app.config import settings


@pytest.fixture
def client():
    c = TestClient(app)
    c.headers.update({"X-API-Key": settings.backend_api_key})
    return c


@pytest.fixture
def client_no_auth():
    """A client with no X-API-Key header, for testing the auth boundary itself."""
    return TestClient(app)


@pytest.fixture(autouse=True)
def reset_rate_limit_state():
    """`enforce_rate_limit` in app.main keys its window/count dict by
    request.client.host, which TestClient always reports as the same fake
    host. Without resetting this between tests, any test that makes enough
    /analyze calls (e.g. the rate-limit burst test itself) would silently
    poison every test that runs after it in the same session."""
    from app import main as main_module
    main_module._rate_limit_state.clear()
    yield
    main_module._rate_limit_state.clear()
