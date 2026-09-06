import base64
import io
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from segmentation_server import app


class MaskValidationTests(unittest.TestCase):
    def setUp(self):
        # No lifespan: validation tests neither download nor initialize the model.
        self.client = TestClient(app)
        data = io.BytesIO()
        Image.new("RGB", (20, 20)).save(data, format="PNG")
        self.image = base64.b64encode(data.getvalue()).decode()

    def test_invalid_image_and_boxes(self):
        for payload in [
            {"image": "bad image", "box": [0, 0, 10, 10]},
            {"image": self.image, "box": [10, 10, 0, 0]},
            {"image": self.image, "box": [0, 0, 100, 100]},
        ]:
            self.assertEqual(self.client.post("/api/segmentation/mask", json=payload).status_code, 400)

    def test_uninitialized_model_returns_actionable_error(self):
        result = self.client.post("/api/segmentation/mask", json={"image": self.image, "box": [0, 0, 10, 10]})
        self.assertEqual(result.status_code, 503)

    def test_request_size_is_bounded(self):
        result = self.client.post("/api/segmentation/mask", content=b"x" * 8_100_001)
        self.assertEqual(result.status_code, 413)

    def test_world_ids_are_validated_and_credentials_stay_server_side(self):
        self.assertEqual(self.client.get("/api/segmentation/worlds/not-a-world").status_code, 422)
        with patch.dict(os.environ, {}, clear=True):
            result = self.client.get("/api/segmentation/worlds/b9343ffa-0b73-433b-98db-b4c448d93224")
            self.assertEqual(result.status_code, 503)


if __name__ == "__main__":
    unittest.main()
