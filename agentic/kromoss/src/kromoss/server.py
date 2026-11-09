"""Lightweight OpenAI-compatible image interface without model residency."""

import base64
import collections.abc as c
import logging
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel

from .runtime import (
    ClientDisconnectedError,
    ImageRuntime,
    RuntimeClosedError,
    WorkerBusyError,
    WorkerFailedError,
)

logger = logging.getLogger(__name__)
MODEL = "lodestones/Kromoss"


class ImageRequest(BaseModel):
    """Preserve the existing Kromoss generation request contract."""

    model: str
    prompt: str
    size: str = "1024x1024"
    n: int = 1
    seed: int = 42
    response_format: str = "b64_json"


def create_app(*, runtime: ImageRuntime | None = None) -> FastAPI:
    """Create the HTTP interface around a request-owned worker runtime.

    Args:
        runtime (optional):
            Isolated worker owner. Defaults to the installed model worker.

    Returns:
        Application with shutdown cleanup and unchanged generation routes.
    """
    owner = runtime if runtime is not None else ImageRuntime()

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> c.AsyncGenerator[None]:
        """Retain worker ownership until application shutdown completes.

        Args:
            _app:
                Application whose lifespan is running.

        Returns:
            Lifespan context.
        """
        try:
            yield
        finally:
            await owner.close()

    app = FastAPI(lifespan=lifespan)
    app.state.runtime = owner
    app.get("/v1/models")(_models)

    @app.post("/v1/images/generations")
    async def generate(body: ImageRequest, request: Request) -> dict[str, object]:
        """Generate one image and release its model before replying.

        Args:
            body:
                Generation parameters.
            request:
                Connection used to detect a caller disconnect.

        Returns:
            Timestamp and a base64-encoded PNG in the existing response format.
        """
        _validate(body=body)
        try:
            data = await owner.generate(
                payload=body.model_dump(), disconnected=request.is_disconnected
            )
        except WorkerBusyError as exc:
            raise HTTPException(429, "Image worker busy") from exc
        except RuntimeClosedError as exc:
            raise HTTPException(503, "Image worker is shutting down") from exc
        except ClientDisconnectedError as exc:
            raise HTTPException(499, "Image caller disconnected") from exc
        except TimeoutError as exc:
            raise HTTPException(504, "Image generation timed out") from exc
        except (WorkerFailedError, OSError) as exc:
            logger.exception("Kromoss image generation failed")
            raise HTTPException(502, "Image worker failed") from exc
        return {
            "created": int(time.time()),
            "data": [{"b64_json": base64.b64encode(data).decode("ascii")}],
        }

    return app


def _models() -> dict[str, object]:
    """List the model independently of worker residency.

    Returns:
        OpenAI-compatible model listing.
    """
    return {"object": "list", "data": [{"id": MODEL, "object": "model"}]}


def _validate(*, body: ImageRequest) -> None:
    """Enforce the deployed image model's existing parameter limits.

    Args:
        body:
            Parsed generation parameters.
    """
    if (
        body.model != MODEL
        or not body.prompt.strip()
        or body.n != 1
        or body.response_format != "b64_json"
    ):
        raise HTTPException(
            400, "Invalid model, prompt, image count or response format"
        )
    try:
        width, height = (int(part) for part in body.size.split("x"))
    except ValueError as exc:
        raise HTTPException(400, "Invalid size") from exc
    if not (
        512 <= width <= 1024
        and 512 <= height <= 1024
        and width * height <= 1048576
        and width % 16 == 0
        and height % 16 == 0
        and 0 <= body.seed < 2**32
    ):
        raise HTTPException(400, "Invalid size or seed")
