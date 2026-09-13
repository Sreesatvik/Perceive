import os
import base64

ARTIFACT_ROOT = "artifacts"

def save_redacted_image(session_id: str, step_number: int, redacted_image_base64: str) -> str | None:
    """Saves a redacted image to disk for demo/audit purposes. Returns the file path, or None if no image was provided."""
    if not redacted_image_base64:
        return None
    session_dir = os.path.join(ARTIFACT_ROOT, session_id)
    os.makedirs(session_dir, exist_ok=True)
    file_path = os.path.join(session_dir, f"{step_number}_redacted.png")
    try:
        image_bytes = base64.b64decode(redacted_image_base64)
        with open(file_path, "wb") as f:
            f.write(image_bytes)
        return file_path
    except Exception:
        return None  # never let artifact persistence break the main request
