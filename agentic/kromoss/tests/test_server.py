"""Verify the existing router-facing image contract with CPU workers."""

import base64
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from kromoss.runtime import ImageRuntime
from kromoss.server import MODEL, create_app

FAKE = Path(__file__).parent / "fixtures" / "fake_worker.py"


def test_models_and_generation_preserve_contract(tmp_path: Path) -> None:
    """Model listing remains available when no model worker exists."""
    owner = ImageRuntime(command=(sys.executable, str(FAKE)), temp_root=tmp_path)
    with TestClient(create_app(runtime=owner)) as client:
        response = client.get("/v1/models")
        assert response.json() == {
            "object": "list",
            "data": [{"id": MODEL, "object": "model"}],
        }
        response = client.post(
            "/v1/images/generations",
            json={"model": MODEL, "prompt": "success", "size": "512x512"},
        )
        assert response.status_code == 200
        assert isinstance(response.json()["created"], int)
        data = base64.b64decode(response.json()["data"][0]["b64_json"])
        assert data.startswith(b"\x89PNG")
    assert not list(tmp_path.iterdir())


@pytest.mark.parametrize(
    "override",
    [
        {"model": "wrong"},
        {"prompt": "  "},
        {"n": 2},
        {"response_format": "url"},
        {"size": "oops"},
        {"size": "512x512x512"},
        {"size": "256x512"},
        {"size": "513x512"},
        {"seed": -1},
        {"seed": 2**32},
    ],
)
def test_invalid_request_never_starts_worker(
    tmp_path: Path, override: dict[str, str | int]
) -> None:
    """Existing validation fails before any model process is spawned."""
    owner = ImageRuntime(command=("/must/not/be/executed",), temp_root=tmp_path)
    payload = {"model": MODEL, "prompt": "success", "size": "512x512", **override}
    with TestClient(create_app(runtime=owner)) as client:
        response = client.post("/v1/images/generations", json=payload)
    assert response.status_code == 400
    assert not list(tmp_path.iterdir())


def test_worker_failure_returns_bounded_error(tmp_path: Path) -> None:
    """Worker failures do not leak internal paths or return partial images."""
    owner = ImageRuntime(command=(sys.executable, str(FAKE)), temp_root=tmp_path)
    with TestClient(create_app(runtime=owner)) as client:
        response = client.post(
            "/v1/images/generations",
            json={"model": MODEL, "prompt": "exit", "size": "512x512"},
        )
    assert response.status_code == 502
    assert response.json() == {"detail": "Image worker failed"}
    assert not list(tmp_path.iterdir())


def test_worker_timeout_returns_gateway_timeout(tmp_path: Path) -> None:
    """Deadlines map onto the router-facing gateway timeout contract."""
    owner = ImageRuntime(
        command=(sys.executable, str(FAKE)), timeout=0.5, temp_root=tmp_path
    )
    with TestClient(create_app(runtime=owner)) as client:
        response = client.post(
            "/v1/images/generations",
            json={"model": MODEL, "prompt": "hold", "size": "512x512"},
        )
    assert response.status_code == 504
    assert not list(tmp_path.iterdir())
