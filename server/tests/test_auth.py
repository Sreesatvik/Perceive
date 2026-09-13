import importlib
import pytest


ANALYZE_PAYLOAD = {
    "session_id": "auth-test-session",
    "task_instruction": "submit form",
    "step_number": 1,
    "dom_summary": {"url": "http://test.com", "elements": []}
}


def test_analyze_missing_api_key_rejected(client_no_auth):
    response = client_no_auth.post("/analyze", json=ANALYZE_PAYLOAD)
    assert response.status_code == 401


def test_analyze_wrong_api_key_rejected(client_no_auth):
    client_no_auth.headers.update({"X-API-Key": "wrong-key"})
    response = client_no_auth.post("/analyze", json=ANALYZE_PAYLOAD)
    assert response.status_code == 401


def test_session_end_missing_api_key_rejected(client_no_auth):
    response = client_no_auth.post(
        "/session/some-session/end", json={"reason": "test"}
    )
    assert response.status_code == 401


def test_analyze_correct_api_key_proceeds_past_auth(client):
    # No mocking of generate_action here: a correct key must get past the
    # auth dependency and into business logic (a real network/LLM call will
    # fail without credentials, but that failure must NOT be a 401).
    response = client.post("/analyze", json=ANALYZE_PAYLOAD)
    assert response.status_code != 401


def test_missing_backend_api_key_fails_app_boot(monkeypatch, tmp_path):
    """Regression test: config.py must fail fast at import/boot time if
    BACKEND_API_KEY is not set, rather than silently disabling auth.

    pydantic-settings' precedence is env vars > .env file > defaults, so
    deleting the env var alone isn't enough to prove this when a real local
    server/.env exists (as it does for real development) — it would just
    fall through to that file's value. chdir to an empty tmp_path so
    Settings' relative env_file=".env" resolves to nowhere, truly isolating
    this test from whatever .env the developer happens to have configured.
    """
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("LLM_PROVIDER", "offline")
    monkeypatch.setenv("MODEL_NAME", "test-model")
    monkeypatch.setenv("OFFLINE_API_BASE", "http://localhost:11434/v1")
    monkeypatch.setenv("ALLOWED_ORIGINS", "http://localhost:3000")
    monkeypatch.delenv("BACKEND_API_KEY", raising=False)

    from app import config as config_module

    with pytest.raises(ValueError, match="BACKEND_API_KEY"):
        importlib.reload(config_module)

    # Restore the module to its valid state for any tests that run after
    # this one in the same session.
    monkeypatch.setenv("BACKEND_API_KEY", "test-api-key")
    importlib.reload(config_module)
