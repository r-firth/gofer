"""Exercise real Web Push encryption while replacing only its HTTP transport."""

import base64
import json
import unittest
from unittest.mock import Mock

import http_ece
import push
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec


class PushTests(unittest.TestCase):
    def test_payload_is_encrypted_for_the_subscribed_browser(self):
        receiver = ec.generate_private_key(ec.SECP256R1())
        public = receiver.public_key().public_bytes(
            serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
        )
        auth = b"0123456789abcdef"

        def encode(data):
            return base64.urlsafe_b64encode(data).decode().rstrip("=")

        subscription = {
            "endpoint": "https://fcm.googleapis.com/test",
            "keys": {"auth": encode(auth), "p256dh": encode(public)},
        }
        session = Mock()
        session.post.return_value.status_code = 201
        payload = {"title": "Work finished", "chat_id": "chat-123"}
        self.assertEqual(
            push.send(
                {"keys": push.keys(), "subscription": subscription, "payload": payload},
                session,
            ),
            201,
        )
        request = session.post.call_args
        encrypted = request.kwargs["data"]
        self.assertNotIn(b"chat-123", encrypted)
        self.assertEqual(
            json.loads(
                http_ece.decrypt(
                    encrypted,
                    private_key=receiver,
                    auth_secret=auth,
                    version="aes128gcm",
                )
            ),
            payload,
        )
        self.assertEqual(request.kwargs["timeout"], 15)
        self.assertIn("vapid", request.kwargs["headers"]["authorization"])


if __name__ == "__main__":
    unittest.main()
