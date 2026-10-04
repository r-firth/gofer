"""Web Push crypto/transport. Keys and subscriptions arrive on stdin, never argv."""

import base64
import json
import sys

import requests
from cryptography.hazmat.primitives import serialization
from py_vapid import Vapid02
from pywebpush import WebPushException, webpush


class NoRedirects(requests.Session):
    def request(self, *args, **kwargs):
        kwargs["allow_redirects"] = False
        return super().request(*args, **kwargs)


def keys():
    key = Vapid02()
    key.generate_keys()
    private = key.private_key.private_bytes(
        serialization.Encoding.DER,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )
    public = key.public_key.public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
    )

    def encode(value):
        return base64.urlsafe_b64encode(value).decode().rstrip("=")

    return {"private": encode(private), "public": encode(public)}


def send(task, session=None):
    try:
        vapid = Vapid02.from_string(task["keys"]["private"])
        # py-vapid's strict regex rejects valid HTTPS contact URLs with paths.
        # This is a fixed RFC 8292 contact URI; audience validation still applies.
        vapid.conf["no-strict"] = True
        response = webpush(
            task["subscription"],
            json.dumps(task["payload"]),
            vapid_private_key=vapid,
            vapid_claims={"sub": "https://github.com/r-firth/gofer"},
            timeout=15,
            ttl=3600,
            headers={"Urgency": "normal"},
            requests_session=session or NoRedirects(),
        )
        return response.status_code
    except WebPushException as error:
        return error.response.status_code if error.response is not None else 503
    except requests.RequestException:
        return 503


if __name__ == "__main__":
    task = json.load(sys.stdin)
    print(json.dumps(keys() if task.get("generate") else {"status": send(task)}))
