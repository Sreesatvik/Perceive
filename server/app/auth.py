import os
from fastapi import Header, HTTPException
from .config import settings

def require_api_key(x_api_key: str = Header(None)):
    expected = settings.backend_api_key
    if not expected:
        raise HTTPException(status_code=500, detail="Server misconfigured")
    if not x_api_key or x_api_key != expected:
        raise HTTPException(status_code=401, detail="Invalid or missing API key")
    return True